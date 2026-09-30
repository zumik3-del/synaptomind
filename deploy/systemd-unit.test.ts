import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// render_systemd_unit() (deploy/lib/common.sh) is the ONLY place a unit body is
// produced — install.sh:453 and update.sh:139 both call it. So the restart
// policy is asserted HERE, at the source, rather than through two install
// harnesses that would each prove it only for their own DIST.
//
// The task it guards: on 2026-09-30 production stayed down for 12 minutes. The
// app registers SIGTERM/SIGINT handlers (src/index.ts:117-123), so an external
// signal produced a graceful shutdown and exit status 0 — and the template
// carried `Restart=on-failure`, which deliberately does not restart a clean
// exit. The signal was a name-pattern `pkill -f 'bun run src/index.ts'` from
// another agent's harness cleanup, and production runs as the same unprivileged
// user every agent runs as, so no privilege was involved and no sudo/systemd
// trace was left. AGENTS.md §8 forbids that pattern; this suite makes the other
// half of the fix durable, so a lost signal is an outage of seconds, not minutes.
//
// Why `always` and not `on-abnormal`: a handler that runs the shutdown path and
// exits 0 is a CLEAN exit by systemd's definition, and `on-abnormal` only acts
// on unclean signal/timeout/watchdog/OOM — it would have sat down through the
// exact same incident. Status 0 must not be a one-way door.
//
// Behaviour beyond this file (needs a systemd user manager, so it lives in the
// repro harness rather than in CI): a transient `systemd-run --user` unit on
// Restart=always, sent SIGTERM, comes back on its own (MainPID changes,
// NRestarts=1); on Restart=on-failure the same signal leaves it inactive. A
// deliberate `systemctl stop` is still honoured under `always` — the unit is
// left inactive and not respawned. StartLimitIntervalSec/Burst in the template
// are what keep `always` from turning a genuine crash loop into a respawn storm.
//
// No sudo, no systemctl, no service, no network: this is a pure bash function
// call against the real lib/common.sh, same approach as wait-health.test.ts.

const LIB = join(import.meta.dir, 'lib', 'common.sh')

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type UnitOpts = { dist?: string; dataDir?: string; bunBin?: string }

/** Render a unit with the real common.sh, exactly as install.sh/update.sh do. */
function renderUnit(opts: UnitOpts = {}): string {
  const env: Record<string, string> = {
    APP_DESC: 'Synaptomind — thought-graph engine',
    TARGET_USER: 'synaptomind',
    TARGET_HOME: '/home/synaptomind',
    INSTALL_DIR: '/opt/synaptomind',
    DATA_DIR: opts.dataDir ?? '/var/lib/synaptomind',
    BUN_BIN: opts.bunBin ?? '/usr/local/bin/bun',
    DIST: opts.dist ?? 'source',
  }
  const script =
    Object.entries(env)
      .map(([k, v]) => `${k}=${quote(v)}`)
      .join('\n') +
    `\n. ${quote(LIB)}\nrender_systemd_unit "/usr/local/bin/bun run start"\n`
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 })
  if (res.status !== 0) throw new Error(`render_systemd_unit failed: ${res.stderr}`)
  return res.stdout
}

/** Every line that sets a restart policy, in file order. */
function restartDirectives(unit: string): string[] {
  return unit.split('\n').filter((l) => /^Restart=/.test(l.trim()))
}

describe('render_systemd_unit — restart policy', () => {
  test('renders Restart=always, never the on-failure that caused the outage', () => {
    const unit = renderUnit()

    expect(unit).toContain('\nRestart=always\n')
    // The regression this task exists for: on-failure leaves a signalled,
    // gracefully-exited service down until a human notices.
    expect(unit).not.toContain('Restart=on-failure')
    expect(unit).not.toContain('Restart=on-abnormal')
    expect(unit).not.toContain('Restart=on-watchdog')
    // systemd honours the LAST Restart= it reads, so a second directive would
    // silently reintroduce whichever policy was appended.
    expect(restartDirectives(unit)).toEqual(['Restart=always'])
  })

  test('the policy is identical in source and binary mode', () => {
    // install.sh:453 and update.sh:139 share this function, but DIST changes
    // the [Service] body, so the policy is asserted in both arms rather than
    // assumed to be shared.
    for (const dist of ['source', 'binary']) {
      expect(restartDirectives(renderUnit({ dist })), `DIST=${dist}`).toEqual(['Restart=always'])
    }
  })

  test('Restart=always stays bounded by StartLimit* so a crash loop cannot storm', () => {
    // `always` is only safe because a fast crash loop still hits the start
    // limit. These live in [Unit]; assert them together with the policy so a
    // future edit cannot keep `always` and quietly drop the bound.
    const unit = renderUnit()

    expect(unit).toContain('\nRestartSec=5\n')
    expect(unit).toContain('\nStartLimitIntervalSec=60\n')
    expect(unit).toContain('\nStartLimitBurst=5\n')
    // StartLimit* are [Unit] directives, Restart is [Service]: if a future edit
    // merges the sections the ordering below would stop being meaningful.
    expect(unit.indexOf('[Service]')).toBeLessThan(unit.indexOf('Restart=always'))
    expect(unit.indexOf('StartLimitBurst=5')).toBeLessThan(unit.indexOf('[Service]'))
  })
})