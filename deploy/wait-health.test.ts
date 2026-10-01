import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installCleanup, mkTempTree } from './tmp-fixtures'

// The gate fixture's scratch tree is owned by mkTempTree, so the sweep removes
// it even when a test throws mid-run. See tmp-fixtures.ts.
installCleanup()

// wait_health() (deploy/lib/common.sh) is the gate an install/update passes
// through. The task it guards: a unit rendered WITHOUT Environment=LD_LIBRARY_PATH
// makes the embedder child die on ERR_DLOPEN_FAILED in a loop, while /health
// still answers status "ok" — so a gate that reads only `status` prints clean
// success over permanently dead embeddings.
//
// Driven here directly against the real lib/common.sh rather than through
// install.sh/update.sh (see updater.sh.test.ts for those end-to-end cases):
// `url_get` is a bash function, so redefining it after sourcing replaces the
// curl call and lets a test script an arbitrary sequence of /health payloads —
// including "failed now, healthy on the next poll", which a single static body
// cannot express. No network, no service, no sudo.

const LIB = join(import.meta.dir, 'lib', 'common.sh')

/** POSIX single-quoting, so a JSON body survives into the bash script verbatim. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type Gate = { status: number | null; stdout: string; stderr: string; polls: number; failure: string }

/**
 * One /health sample. A bare string is a complete answer (url_get exits 0).
 *
 * `{ body, rc }` is a sample that did NOT arrive whole — the shape a body that
 * dies mid-transfer has, and the one the truncation case needs: real curl leaves
 * rc=18 (transfer closed with N bytes remaining) and whatever it had already
 * written, so a partial body and a non-zero rc are the SAME event, not two.
 */
type Sample = string | { body: string; rc: number }

/**
 * Run wait_health with a scripted sequence of /health bodies.
 *
 * `bodies` are returned one per poll; once exhausted, url_get fails, which the
 * gate treats as "no sample yet" — unless `repeatLast` is set, in which case the
 * last sample keeps being served. Repeat it whenever that last sample IS the
 * condition under test: the verdict is read off the last poll (#1099), so "the
 * embedder is dead" and "the service serves the old version" have to be
 * PERSISTENT answers, not a single observation that silence may follow.
 *
 * Every poll is counted into a file, so a test can assert HOW MANY samples the
 * gate consumed — without that, a test that passes on the first healthy sample
 * proves nothing about a recovery.
 */
function runGate(
  bodies: Sample[],
  opts: {
    expected?: string | null
    timeout?: number
    installDir?: string
    /** Keep serving the last sample once the sequence is exhausted. */
    repeatLast?: boolean
  } = {}
): Gate {
  const expected = opts.expected === undefined ? '0.8.0' : opts.expected
  const timeout = opts.timeout ?? 1
  const installDir = opts.installDir ?? '/opt/synaptomind-gate-test'
  const samples = bodies.map((b) => (typeof b === 'string' ? { body: b, rc: 0 } : b))
  const dir = mkTempTree('synaptomind-gate-')
  const pollFile = join(dir, 'polls')
  const script = `
APP_NAME=synaptomind
INSTALL_DIR=${quote(installDir)}
. ${quote(LIB)}
__bodies=(${samples.map((s) => quote(s.body)).join(' ')})
__rcs=(${samples.map((s) => String(s.rc)).join(' ')})
__repeat=${quote(opts.repeatLast ? 'true' : 'false')}
__poll=${quote(pollFile)}
url_get() {
  # The counter lives in a FILE: wait_health calls url_get inside a command
  # substitution, so a shell variable would be lost in the subshell.
  __n=$(cat "$__poll" 2>/dev/null || printf '0')
  __n=$((__n + 1))
  printf '%s' "$__n" > "$__poll"
  if [ "$__n" -gt "\${#__bodies[@]}" ]; then
    if [ "$__repeat" != true ]; then return 1; fi
    __n="\${#__bodies[@]}"
  fi
  printf '%s' "\${__bodies[$((__n - 1))]}"
  return "\${__rcs[$((__n - 1))]}"
}
wait_health "http://127.0.0.1:1/health" ${quote(expected ?? '')} ${quote(String(timeout))}
__rc=$?
# HEALTH_FAILURE is what update.sh branches on, so a test has to see it.
printf 'HEALTH_FAILURE=%s\\n' "\${HEALTH_FAILURE:-<unset>}"
exit $__rc
`
  try {
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
    const polls = readFileSync(pollFile, 'utf8').trim()
    const failure = /HEALTH_FAILURE=(.*)/.exec(res.stdout)?.[1] ?? '<unset>'
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      polls: Number(polls || 0),
      failure,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A /health payload as getHealthService() actually emits it. */
function payload(
  embedder: string | null,
  opts: { status?: string; version?: string } = {}
): string {
  const version = opts.version ?? '0.8.0'
  const status = opts.status ?? 'ok'
  const checks = embedder === null ? {} : { database: 'ok', embedder }
  return JSON.stringify({ status, version, checks })
}

describe('wait_health — checks.embedder gate (both directions)', () => {
  test('a ready embedder passes', () => {
    const gate = runGate([payload('ok')])

    expect(gate.status, gate.stderr).toBe(0)
    expect(gate.stdout).toContain('Service is healthy, reported version 0.8.0')
  })

  test('a still-loading embedder passes (first install, model downloading)', () => {
    // ADR 0001 §2.2 relies on this: a cold binary install answers "not ready"
    // for as long as the model downloads. A regression here breaks every cold
    // install, which is why "not ready" must NOT be treated as a failure.
    const gate = runGate([payload('not ready')])

    expect(gate.status, gate.stderr).toBe(0)
    expect(gate.stdout).toContain('Service is healthy')
  })

  test('a still-loading embedder passes on a degraded status too', () => {
    // wait_health deliberately accepts "degraded" as well as "ok" (SynaptoMind
    // deviation from the upstream template); the loading case must survive both.
    const gate = runGate([payload('not ready', { status: 'degraded' })])

    expect(gate.status, gate.stderr).toBe(0)
  })

  test('a dead embedder fails the gate and names the LD_LIBRARY_PATH remedy', () => {
    // checks.embedder=failed with a perfectly healthy status and the expected
    // version: what the crashed child produces. The gate must not wave it through.
    // timeout 6 (not 2): the gate sleeps 2s between polls, and the poll-count
    // assertion below needs the second sample to be reached — the slack absorbs
    // a loaded machine overshooting the sleep. repeatLast: a dead embedder is a
    // PERSISTENT answer, and the verdict is read off the last poll (#1099) — a
    // "failed" sample the service then stopped reporting would be a timeout, not
    // a dead embedder, and must be asserted as such in the truncation cases.
    const gate = runGate([payload('failed'), payload('failed')], { timeout: 6, repeatLast: true })

    expect(gate.status).toBe(1)
    expect(gate.stdout).not.toContain('Service is healthy')
    expect(gate.stderr).toContain('checks.embedder=failed')
    expect(gate.stderr).toContain('LD_LIBRARY_PATH=/opt/synaptomind-gate-test/lib')
    expect(gate.stderr).toContain('ADR 0001')
    // Not latched, and reported only when the timeout expires: the gate keeps
    // polling so a self-healing child can still pass (see the recovery case).
    expect(gate.polls).toBeGreaterThanOrEqual(2)
  }, 30_000)

  test('a dead embedder also fails the version-less gate', () => {
    // The second success arm: wait_health called with no expected version still
    // has to consult checks.embedder.
    const gate = runGate([payload('failed')], { expected: null })

    expect(gate.status).toBe(1)
    expect(gate.stderr).toContain('checks.embedder=failed')
  })

  test('a failed sample followed by a healthy sample passes (recovery)', () => {
    // The app clears its own latch once the embedder becomes ready, so the gate
    // re-derives the verdict per sample: an install left healthy must not fail
    // on a transient crash it recovered from.
    const gate = runGate([payload('failed'), payload('ok')], { timeout: 8 })

    expect(gate.status, gate.stderr).toBe(0)
    expect(gate.stdout).toContain('Service is healthy')
    // Proves the recovery sample was really consumed, not skipped.
    expect(gate.polls).toBeGreaterThanOrEqual(2)
  }, 30_000)

  test('a payload without checks.embedder keeps the pre-gate behaviour', () => {
    // Backwards compatibility: a payload predating the field carries no signal,
    // which must read as "unknown", not as a failure.
    const legacy = runGate([payload(null)])
    expect(legacy.status, legacy.stderr).toBe(0)

    const otherChecks = runGate([
      JSON.stringify({ status: 'ok', version: '0.8.0', checks: { database: 'ok' } })
    ])
    expect(otherChecks.status, otherChecks.stderr).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  F4 — the gate must be able to tell its OWN service from another process
//  holding the port.
//
//  The version-less arm used to accept ANY non-empty body: a reverse proxy, a
//  stale instance of the app, or anything else on the port answered, the gate
//  read "not a dead embedder" and returned 0. update.sh's poll is only
//  version-less when the target version could not be resolved, which is exactly
//  when the one signal that could have identified the responder was dropped.
//
//  So a sample must carry the /health CONTRACT before it can pass: a `status`
//  of ok|degraded and a `version`. `version` is what the check compares when it
//  has an expectation; requiring it always is what keeps the version-less call
//  from passing on a stranger.
// ══════════════════════════════════════════════════════════════════════════════

describe('wait_health — a foreign responder on the port is not the service', () => {
  test('a non-/health body fails the version-less gate', () => {
    // The counterexample: the old gate returned 0 for any non-empty body, so a
    // foreign process on the port passed as "Service is healthy". expected: null
    // is the point — with an expectation the version check would have caught it.
    const gate = runGate([JSON.stringify({ hello: 'world' })], { expected: null })

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
    expect(gate.stdout).not.toContain('Service is healthy')
  })

  test('an HTML error page from a proxy fails the version-less gate', () => {
    const gate = runGate(['<html><body>502 Bad Gateway</body></html>'], { expected: null })

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
  })

  test('a well-formed /health still passes the version-less gate', () => {
    // The contract is the discriminator, not a blanket "no expectation means no
    // check": the real payload carries status + version, so it passes.
    const gate = runGate([payload('ok')], { expected: null })

    expect(gate.status, gate.stderr).toBe(0)
    expect(gate.stdout).toContain('Service is healthy')
  })

  test('a /health with no version field is not accepted as identity', () => {
    // `status` alone cannot tell two instances of the same app apart, and a
    // responder that reports no version cannot be identified at all.
    const gate = runGate([JSON.stringify({ status: 'ok', checks: {} })], { expected: null })

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  A body that dies MID-TRANSFER, then silence, is not an OBSERVED failure.
//
//  The identity verdict was the one signal re-derived only inside the
//  non-empty-body branch, so a poll that answered NOTHING inherited it: a
//  short body set `foreign`, the next silent poll left it set, and the verdict
//  came out `contract` — an OBSERVED failure. update.sh treats that as
//  confirmed: it skips health_recheck (the re-check exists exactly to stop a
//  destructive remedy on an unconfirmed failure) and prints the per-database
//  restore.
//
//  The sequence is a body that DIES mid-transfer, not merely a non-empty body.
//  A server that closes mid-body leaves real curl rc=18 with a SHORT body —
//  measured on this host at 25 bytes of a promised 4096 — and a partial body
//  during a rolling restart is an ordinary transient, not a stranger on the
//  port. Each sample is `{ body, rc }` for that reason: the partial body and
//  the failed transfer are one event, not two.
// ══════════════════════════════════════════════════════════════════════════════

describe('wait_health — a body that dies mid-transfer, then silence, is unverified', () => {
  // A 502 page cut off mid-word: a foreign responder that stopped talking.
  const CUT_OFF = { body: '<html><head><title>502 Ba', rc: 18 }
  // The service then refuses the connection: nothing on the port at all.
  const SILENCE = { body: '', rc: 7 }

  test('a truncated foreign body followed by silence is a TIMEOUT, not a contract failure', () => {
    // The finding, verbatim. timeout 6 so the silent polls after the truncated
    // one are really consumed — with the verdict latched, the very first silent
    // poll is what carries the false `contract` to the end of the window.
    const gate = runGate([CUT_OFF, SILENCE], { timeout: 6, repeatLast: true })

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
    // The verdict update.sh branches on, and the branch that is WRONG here.
    expect(gate.failure, 'a silent poll must inherit no identity verdict').toBe('timeout')
    // Silence is not a stranger on the port, so the contract diagnosis must not
    // be offered: it sends the operator hunting for another process.
    expect(gate.stderr).not.toContain('not with a')
    expect(gate.polls).toBeGreaterThanOrEqual(2)
  }, 30_000)

  test('a truncated body carrying embedder=failed, then silence, is also a timeout', () => {
    // The same latch in the second signal: embedder_dead was re-derived inside
    // the same branch, so a poll that read no embedder at all inherited it —
    // and the embedder verdict is checked FIRST, so it outranked timeout. A
    // body cut off inside the `embedder` field is the same transient.
    const gate = runGate(
      [
        {
          body: '{"status":"ok","version":"0.8.0","checks":{"database":"ok","embedder":"failed"}',
          rc: 18,
        },
        SILENCE,
      ],
      { timeout: 6, repeatLast: true },
    )

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
    expect(gate.failure).toBe('timeout')
    expect(gate.stderr).not.toContain('checks.embedder=failed')
  }, 30_000)

  test('a wrong version that KEEPS answering is still a confirmed failure', () => {
    // The direction that must not move. A service observed serving the old
    // payload has earned the remedy, so the verdict stays `version` and the
    // message still names both versions. A fix that bought its quiet by
    // swallowing contradicting samples fails here.
    const stale = JSON.stringify({ status: 'ok', version: '0.7.9', checks: { database: 'ok' } })
    const gate = runGate([stale, stale], { expected: '0.8.0', timeout: 6, repeatLast: true })

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
    expect(gate.failure).toBe('version')
    expect(gate.stderr).toContain('reports version 0.7.9, expected 0.8.0')
  }, 30_000)

  test('a truncated body followed by a real wrong version is still confirmed', () => {
    // The pair that rules out "silence the transient by going quiet after any
    // bad body": a transient first, then a sample that CONTRADICTS the update.
    // The last sample decides, and a contradiction is a verdict.
    const stale = JSON.stringify({ status: 'ok', version: '0.7.9', checks: { database: 'ok' } })
    const gate = runGate([CUT_OFF, stale], { expected: '0.8.0', timeout: 8, repeatLast: true })

    expect(gate.status, gate.stdout + gate.stderr).toBe(1)
    expect(gate.failure).toBe('version')
  }, 30_000)
})
