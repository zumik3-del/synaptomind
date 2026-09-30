import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

type Gate = { status: number | null; stdout: string; stderr: string; polls: number }

/**
 * Run wait_health with a scripted sequence of /health bodies.
 *
 * `bodies` are returned one per poll; once exhausted, url_get fails, which the
 * gate treats as "no sample yet". Every poll is counted into a file, so a test
 * can assert HOW MANY samples the gate consumed — without that, a test that
 * passes on the first healthy sample proves nothing about a recovery.
 */
function runGate(
  bodies: string[],
  opts: { expected?: string | null; timeout?: number; installDir?: string } = {}
): Gate {
  const expected = opts.expected === undefined ? '0.8.0' : opts.expected
  const timeout = opts.timeout ?? 1
  const installDir = opts.installDir ?? '/opt/synaptomind-gate-test'
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-gate-'))
  const pollFile = join(dir, 'polls')
  const script = `
APP_NAME=synaptomind
INSTALL_DIR=${quote(installDir)}
. ${quote(LIB)}
__bodies=(${bodies.map(quote).join(' ')})
__poll=${quote(pollFile)}
url_get() {
  # The counter lives in a FILE: wait_health calls url_get inside a command
  # substitution, so a shell variable would be lost in the subshell.
  __n=$(cat "$__poll" 2>/dev/null || printf '0')
  __n=$((__n + 1))
  printf '%s' "$__n" > "$__poll"
  if [ "$__n" -gt "\${#__bodies[@]}" ]; then return 1; fi
  printf '%s' "\${__bodies[$((__n - 1))]}"
}
wait_health "http://127.0.0.1:1/health" ${quote(expected ?? '')} ${quote(String(timeout))}
exit $?
`
  try {
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
    const polls = readFileSync(pollFile, 'utf8').trim()
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, polls: Number(polls || 0) }
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
    // a loaded machine overshooting the sleep.
    const gate = runGate([payload('failed'), payload('failed')], { timeout: 6 })

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