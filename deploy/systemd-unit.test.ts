import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// render_systemd_unit() (deploy/lib/common.sh) is the ONLY place a unit body is
// produced — install.sh and update.sh's refresh_unit() both call it. So the
// restart policy is asserted HERE, at the source, rather than through two
// install harnesses that would each prove it only for their own DIST.
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

type UnitOpts = { dist?: string; dataDir?: string; bunBin?: string; [key: string]: string | undefined }

/** Render a unit with the real common.sh, exactly as install.sh/update.sh do. */
function renderUnit(opts: UnitOpts = {}): string {
  const res = renderWithPath(opts)
  if (res.status !== 0) throw new Error(`render_systemd_unit failed: ${res.stderr}`)
  return res.stdout
}

/**
 * Render with the real common.sh. `opts` overrides the default values by name
 * (dataDir/bunBin/dist for the common cases, or any substituted variable such as
 * APP_DESC / INSTALL_DIR); `env` overrides the ENVIRONMENT of the render process
 * itself, which is what a PATH stub needs.
 */
function renderWithPath(opts: UnitOpts = {}, env: Record<string, string> = {}) {
  const { dataDir, bunBin, dist, ...overrides } = opts
  const base: Record<string, string> = {
    APP_DESC: 'Synaptomind — thought-graph engine',
    TARGET_USER: 'synaptomind',
    TARGET_HOME: '/home/synaptomind',
    INSTALL_DIR: '/opt/synaptomind',
    DATA_DIR: dataDir ?? '/var/lib/synaptomind',
    BUN_BIN: bunBin ?? '/usr/local/bin/bun',
    DIST: dist ?? 'source',
    ...overrides,
    ...env,
  }
  const script =
    Object.entries(base)
      .map(([k, v]) => `${k}=${quote(v)}`)
      .join('\n') +
    `\n. ${quote(LIB)}\nrender_systemd_unit "/usr/local/bin/bun run start"\n`
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 })
}

/**
 * PATH stubs for systemctl / systemd-run / sudo that RECORD every invocation
 * and exit 0 without doing anything. Rendering must never reach them.
 */
function makeRecordingStubs(dir: string): string {
  for (const name of ['systemctl', 'systemd-run', 'sudo']) {
    const p = join(dir, name)
    writeFileSync(
      p,
      [
        '#!/usr/bin/env bash',
        `printf '${name}' >> "$STUB_INVOCATION_LOG"`,
        'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_INVOCATION_LOG"; done',
        'printf \'\\n\' >> "$STUB_INVOCATION_LOG"',
        'exit 0',
      ].join('\n'),
    )
    chmodSync(p, 0o755)
  }
  return dir
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
    // install.sh and update.sh's refresh_unit() share this function, but DIST
    // changes the [Service] body, so the policy is asserted in both arms rather
    // than assumed to be shared.
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
    // Asserted on the DIRECTIVE lines, never on a substring: the comment block
    // above Restart= also says "Restart=always", so indexOf() would be
    // satisfied by the comment and a reverted policy would stay green (the
    // reviewer's mutation M1).
    const restartAt = unit.indexOf('\nRestart=always\n')
    expect(restartAt).toBeGreaterThan(unit.indexOf('[Service]'))
    expect(unit.indexOf('\nStartLimitBurst=5\n')).toBeLessThan(unit.indexOf('[Service]'))
  })
})

describe('render_systemd_unit — rendering executes nothing', () => {
  // The regression CI did not have. The template was an UNQUOTED heredoc
  // (`cat <<EOF`), so every `...` in the restart comment was a command
  // substitution: rendering the unit really ran `systemctl stop` and
  // `systemd-run --user` — on install.sh's path, as root — and the comment
  // shipped to /etc/systemd/system with five holes in it.
  //
  // Stubs record invocations and exit 0; they never exec the real binary, and
  // no systemd, sudo or service is involved.
  function renderWithStubsOnPath(): { unit: string; invocations: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'synapto-render-stubs-'))
    try {
      makeRecordingStubs(dir)
      const log = join(dir, 'invocations.log')
      const res = renderWithPath({}, { PATH: `${dir}:${process.env.PATH}`, STUB_INVOCATION_LOG: log })
      if (res.status !== 0) throw new Error(`render_systemd_unit failed: ${res.stderr}`)
      return { unit: res.stdout, invocations: spawnSync('cat', [log], { encoding: 'utf8' }).stdout, stderr: res.stderr }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('no stub on PATH is invoked while rendering', () => {
    const { invocations, stderr } = renderWithStubsOnPath()

    // (a) not one stub ran. Before the fix this was:
    //   systemctl stop / systemd-run --user, plus "always: command not found" twice.
    expect(invocations).toBe('')
    // Command-not-found noise from the comment's backticks would land on stderr.
    expect(stderr).toBe('')
  })

  test('the rendered body carries no unexpanded substitution artifact', () => {
    const { unit } = renderWithStubsOnPath()

    // (b) The holes the substitutions left: "only  closes that door",
    // "a transient  unit". A backtick pair that renders to nothing shows up as
    // a doubled space where the word used to be.
    expect(unit).not.toMatch(/only {2,}closes that door/)
    expect(unit).not.toMatch(/transient {2,}unit/)
    expect(unit).not.toContain('`')
    expect(unit).not.toContain('$(')
    // Nothing anywhere in the shipped unit may look like shell.
    expect(unit).not.toMatch(/\$\{?[A-Za-z_]/)
  })

  test('the comment keeps its meaning: the policy, the incident and the bound', () => {
    // The comment is documentation an operator reads in `systemctl cat`, so the
    // fix must not gut it to satisfy the test above.
    const { unit } = renderWithStubsOnPath()

    for (const phrase of [
      'Restart=always, not on-failure',
      '2026-09-30 incident',
      'CLEAN exit',
      'systemctl stop',
      'systemd-run --user',
      'StartLimit',
      'deploy/systemd-unit.test.ts',
    ]) {
      expect(unit, phrase).toContain(phrase)
    }
  })

  // ── a line break in a value forges a DIRECTIVE (decided, task #1094) ──────
  // The body is data, not shell, so such a value is inert as shell and NOT
  // inert as unit text. The #1093 re-review measured three forgeries on the
  // shipped renderer: an APP_DESC with a newline produced its own
  // `ExecStartPre=` line, a TARGET_HOME with one produced an `Environment=`
  // line, and an INSTALL_DIR with one produced `ReadWritePaths=/ /`, which with
  // ProtectSystem=strict re-opens the whole filesystem for writing.
  //
  // DECIDED: guard, do not accept. The values are operator-sourced from app.env,
  // so "the operator wrote it" is true and useless — a newline is never a
  // legitimate path or description, and accepting one means shipping a unit
  // whose hardening the operator never wrote. Both answers were live (guard vs.
  // document-and-accept) and leaving it undecided was the one outcome a
  // reviewer cannot check. Refusing fails CLOSED, before anything is written,
  // and names the variable to fix.
  test('a value with a line break is refused, and the variable is named', () => {
    const cases: [string, string][] = [
      ['APP_DESC', 'Synaptomind\nExecStartPre=/bin/sh -c "id > /tmp/pwned"'],
      ['TARGET_HOME', '/home/synaptomind\nEnvironment=EVIL=1'],
      ['INSTALL_DIR', '/opt/synaptomind\nReadWritePaths=/ /'],
      ['DATA_DIR', '/var/lib/synaptomind\rEnvironment=EVIL=1'],
      ['TARGET_USER', 'root\nUser=root'],
      ['BUN_BIN', '/usr/local/bin/bun\nExecStartPre=/bin/false'],
    ]
    for (const [name, value] of cases) {
      const res = renderWithPath({}, { [name]: value })
      // Non-zero, and nothing rendered: a forged unit is not a degraded one.
      expect(res.status, `${name} must fail the render`).not.toBe(0)
      expect(res.stdout, `${name} must not render a unit at all`).toBe('')
      // The message names the variable and the consequence, not just "error".
      expect(res.stderr).toContain(name)
      expect(res.stderr).toContain('line break')
      // The operator is told what a newline would do, because "invalid input"
      // is not actionable.
      expect(res.stderr).toContain('directive')
    }
  })

  test('the refusal happens before anything is written or reloaded', () => {
    // A renderer that half-writes is worse than one that refuses. Same
    // recording stubs as above: a refusal must not have reached systemctl,
    // systemd-run or sudo on the way out.
    const dir = mkdtempSync(join(tmpdir(), 'synapto-render-refuse-'))
    try {
      makeRecordingStubs(dir)
      const log = join(dir, 'invocations.log')
      const res = renderWithPath(
        {},
        {
          INSTALL_DIR: '/opt/synaptomind\nReadWritePaths=/ /',
          PATH: `${dir}:${process.env.PATH}`,
          STUB_INVOCATION_LOG: log,
        },
      )
      expect(res.status).not.toBe(0)
      expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a value with no line break is unaffected (the guard is not a blanket ban)', () => {
    // A guard that rejected ordinary values would make the renderer useless, so
    // pin what it does NOT touch: a path with a space, a dash, an equals sign
    // and a percent, plus a legit multi-line app.env value shape. If a future
    // edit widens the guard, this fails.
    for (const [name, value] of [
      ['INSTALL_DIR', '/opt/synaptomind v2'],
      ['DATA_DIR', '/var/lib/synaptomind-data'],
      ['TARGET_HOME', '/home/synaptomind=1'],
      ['APP_DESC', 'Synaptomind — thought-graph engine (100% coverage)'],
    ] as [string, string][]) {
      const unit = renderUnit({ [name]: value } as UnitOpts & Record<string, string>)
      expect(unit, name).toContain('[Service]')
      expect(unit, name).toContain('Restart=always')
    }
  })

  test('the units systemd-analyze accepts still verify clean', () => {
    // Guard against a malformed body slipping past the substring assertions: a
    // real systemd on the machine verifies the rendered file when it is present.
    const probe = spawnSync('bash', ['-c', 'command -v systemd-analyze'], { encoding: 'utf8' })
    if (probe.status !== 0) return
    const dir = mkdtempSync(join(tmpdir(), 'synapto-unit-verify-'))
    try {
      const p = join(dir, 'synaptomind.service')
      writeFileSync(p, renderUnit())
      const res = spawnSync('systemd-analyze', ['verify', p], { encoding: 'utf8', timeout: 30_000 })
      expect(`${res.stdout}${res.stderr}`).not.toContain('Refusing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})