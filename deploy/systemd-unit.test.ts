import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installCleanup, mkTempTree } from './tmp-fixtures'

// Every scratch tree here comes from mkTempTree, so the sweep removes it even if
// a test throws before its own finally. The per-test try/finally pairs are kept
// (they release earlier; the sweep is `force`, so the second removal is a
// no-op). See tmp-fixtures.ts for why ownership belongs to the creator.
installCleanup()

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

/**
 * Whether this host can be MEASURED against its own systemd parser.
 *
 * The two tests that need it (the ASCII sweep, and the verify-clean check) used
 * to bail out with a bare `return` in the middle of the test body. A test that
 * returns early still reports PASS, so on a host without systemd-analyze 25
 * assertions silently vanished and the run CLAIMED a guarantee it had not
 * checked — found in the #1097 review of task #1096. The skip is explicit and
 * names its reason, so the reporter prints `skip` and the reason together; and
 * `the refusal side is covered with or without systemd` below runs everywhere,
 * so what IS checkable off-systemd is asserted on every host.
 */
const HAS_SYSTEMD_ANALYZE =
  spawnSync('bash', ['-c', 'command -v systemd-analyze'], { encoding: 'utf8' }).status === 0
const SWEEP_SKIP_NOTE = HAS_SYSTEMD_ANALYZE
  ? ''
  : ' — SKIPPED: systemd-analyze is not on PATH on this host, so the parser cannot be measured here'

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
  // `export` is load-bearing here, not decoration. PATH survives a plain
  // assignment because the parent already exports it, but a variable introduced
  // in this script (STUB_INVOCATION_LOG) would stay a shell variable of THIS
  // shell — and the stub that must record is a separate PROCESS, so it saw
  // nothing and recorded nothing. Measured: without export the stub's
  // `>> "$STUB_INVOCATION_LOG"` errors on an empty path (rc=1, no file), with it
  // the log gets the line. So the "not one stub ran" assertion below could not
  // fail for the reason it claims, no matter what the renderer did.
  const script =
    Object.entries(base)
      .map(([k, v]) => `export ${k}=${quote(v)}`)
      .join('\n') +
    `\n. ${quote(LIB)}\nrender_systemd_unit "/usr/local/bin/bun run start"\n`
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 })
}

/**
 * PATH stubs for systemctl / systemd-run / sudo that RECORD every invocation
 * and exit 0 without doing anything. Rendering must never reach them.
 *
 * Returns the invocation log's path, created EMPTY here. The stubs append to
 * it, so a correct render — which invokes nothing — leaves an empty file rather
 * than no file at all. That distinction was lost when the CodeQL autofix
 * (PR #165, commits 805cdfe/acf1c7f) replaced a `spawnSync('cat', [log])` read
 * with readFileSync: `cat` tolerated the missing file (its "No such file" went
 * to stderr while stdout stayed empty) and readFileSync throws ENOENT — four
 * tests failed on CI while passing locally. The helper owns the file, so the
 * helper creates it: "nothing ran" must read as an empty log, not as a crash.
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
  const log = join(dir, 'invocations.log')
  writeFileSync(log, '')
  return log
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
    const dir = mkTempTree('synapto-render-stubs-')
    try {
      const log = makeRecordingStubs(dir)
      const res = renderWithPath({}, { PATH: `${dir}:${process.env.PATH}`, STUB_INVOCATION_LOG: log })
      if (res.status !== 0) throw new Error(`render_systemd_unit failed: ${res.stderr}`)
      return { unit: res.stdout, invocations: readFileSync(log, { encoding: 'utf8' }), stderr: res.stderr }
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

  // ── the same bug in other characters: the CLASS, not the instance ─────────
  // A newline was the first instance of this defect (task #1094) and refusing it
  // was right — but the rule it implemented, "reject \n", is narrower than the
  // defect. systemd's unit parser has several ways to read a value as syntax
  // rather than as data (deploy/lib/common.sh: unit_value_defect), and the
  // backslash is the worst of them: a value ENDING in `\` continues onto the
  // next line, so the directive that follows is absorbed into it, and what it
  // carried is silently gone. Measured on systemd 255 through this renderer
  // (the #1095 review, reproduced by the test below):
  //
  //   DATA_DIR='/var/lib/x\'  -> ReadWritePaths=/opt/y /var/lib/x\
  //                             systemd: "ReadWritePaths= path is not absolute,
  //                             ignoring: PrivateTmp=true"
  //                             => ProtectSystem=strict with NO writable path
  //   APP_DESC='engine\'       -> eats After=network-online.target
  //   TARGET_HOME='/home/x\'   -> eats Environment=PATH=…
  //
  // and systemd-analyze verify reports success, so install.sh prints
  // "Unit verified" over a unit that lost its hardening.
  test('a value systemd would FOLD — a trailing backslash — is refused, and the variable is named', () => {
    const cases: [string, string][] = [
      ['DATA_DIR', '/var/lib/synaptomind\\'],
      ['APP_DESC', 'thought-graph engine\\'],
      ['TARGET_HOME', '/home/synaptomind\\'],
      ['TARGET_USER', 'root\\'],
      ['INSTALL_DIR', '/opt/synaptomind\\'],
      ['BUN_BIN', '/usr/local/bin/bun\\'],
    ]
    for (const [name, value] of cases) {
      const res = renderWithPath({}, { [name]: value })
      expect(res.status, `${name}=${JSON.stringify(value)} must fail the render`).not.toBe(0)
      // Nothing at all rendered: a folded unit is not a degraded one, it is a
      // different unit.
      expect(res.stdout, `${name} must not render a unit at all`).toBe('')
      expect(res.stderr).toContain(name)
      expect(res.stderr).toContain('backslash')
      expect(res.stderr).toContain('directive')
    }
  })

  test('every character systemd reads as syntax is refused, not just the backslash', () => {
    // The class, enumerated. Each entry is a value that this host's systemd
    // measurably does NOT pass through verbatim (the sweep below proves which);
    // the guard is what makes that a refusal instead of a silently mangled
    // directive. This is the test that fails if someone narrows unit_value_defect
    // back to a single character.
    const cases: [string, string][] = [
      // escapes and continuations
      ['INSTALL_DIR', '/opt/synaptomind\\n'],
      ['INSTALL_DIR', '/opt/synaptomind\\ '],
      ['DATA_DIR', '/var/lib/synaptomind\\'],
      // quoting
      ['TARGET_HOME', '/home/"synaptomind'],
      ['TARGET_USER', '"root"'],
      // specifier expansion
      ['INSTALL_DIR', '/opt/%I-synaptomind'],
      ['APP_DESC', 'thought-graph %n engine'],
      // comment characters
      ['APP_DESC', 'thought-graph engine # production'],
      ['APP_DESC', 'thought-graph engine; production'],
      // whitespace systemd strips (an internal space is legitimate and allowed)
      ['INSTALL_DIR', ' /opt/synaptomind'],
      ['DATA_DIR', '/var/lib/synaptomind '],
      // other control characters
      ['APP_DESC', 'thought-graph engine\tproduction'],
      ['APP_DESC', 'thought-graph engineproduction'],
    ]
    for (const [name, value] of cases) {
      const res = renderWithPath({}, { [name]: value })
      expect(res.status, `${name}=${JSON.stringify(value)} must fail the render`).not.toBe(0)
      expect(res.stdout, `${name} must not render a unit at all`).toBe('')
      expect(res.stderr, `${name} must be named`).toContain(name)
    }
  })

  test.skipIf(!HAS_SYSTEMD_ANALYZE)(
    `the guard covers every character the LOCAL systemd parser folds or rewrites${SWEEP_SKIP_NOTE}`,
    () => {
      // The two lists above are only as good as the claim behind them, so MEASURE
      // them here instead of trusting them: for every ASCII byte, put it in a
      // value and ask systemd what it made of it. Anything systemd does not pass
      // through verbatim must be refused by the guard — otherwise this is one more
      // hand-written denylist a future systemd can walk straight past. Measured
      // with `systemd-analyze verify` (never the running manager), one invocation
      // for all the files, diagnostics attributed per file.
      //
      // SKIPPED BY NAME, never silently, when systemd-analyze is absent: a bare
      // `return` here reported PASS on a host that had measured nothing (task
      // #1097). What the skip costs is the FORWARD property only — detecting a
      // future parser that folds a new character. The guard's refusal of the
      // eight characters is asserted on every host by
      // 'the refusal side is covered with or without systemd' below.
      //
      // FOLD: the byte is the last character of a Description value, and a key
      // systemd does NOT know follows on the next line. If that warning is gone,
      // the byte CONTINUED the line and took the directive after it with it —
      // which is finding #1 of the #1095 review. Description= constrains nothing,
      // so a continuation is the only reason its value line can swallow the next
      // one; a value systemd merely rejects leaves the next line in place.
      //
      // REWRITE: the byte sits in the middle of a ReadWritePaths= path, whose
      // diagnostic quotes the path systemd parsed. A different quote is a value
      // that is not the one that was written.
      const dir = mkTempTree('synapto-parser-')
      try {
        const files: string[] = []
        for (let byte = 1; byte < 128; byte++) {
          const ch = String.fromCharCode(byte)
          const fold = join(dir, `fold${byte}.service`)
          writeFileSync(
            fold,
            [
              '[Unit]',
              `Description=SENTINEL${ch}`,
              'ZzProbe=1',
              '',
              '[Service]',
              'Type=simple',
              'ExecStart=/bin/true',
              '',
            ].join('\n'),
          )
          const path = join(dir, `path${byte}.service`)
          writeFileSync(
            path,
            [
              '[Unit]',
              'Description=probe',
              '',
              '[Service]',
              'Type=simple',
              'ExecStart=/bin/true',
              `ReadWritePaths=SENT${ch}INEL`,
              '',
            ].join('\n'),
          )
          files.push(fold, path)
        }
        // SYSTEMD_UNIT_PATH so only these files are loaded: a plain
        // `systemd-analyze verify <file>` also loads every other unit in the
        // host's search path, and their diagnostics would be read as ours.
        const res = spawnSync('systemd-analyze', ['verify', ...files], {
          encoding: 'utf8',
          env: { ...process.env, SYSTEMD_UNIT_PATH: dir },
          timeout: 120_000,
        })
        const lines = `${res.stdout}${res.stderr}`.split('\n')
        const forFile = (name: string) => lines.filter((l) => l.startsWith(`${join(dir, name)}:`))

        // The controls, or the probes measure something other than what they claim:
        // a clean value must be reported verbatim, and the probe line must survive.
        expect(forFile('fold88.service').join('\n'), 'a clean value must keep the next line').toContain(`'ZzProbe'`)
        expect(forFile('path88.service').join('\n'), 'a clean value must be read verbatim').toContain('SENTXINEL')

        // FINDING #1, measured: over all 127 ASCII values, exactly one continues
        // the line — the backslash. Any other entry here is a character a future
        // systemd folds, and the guard has to grow with it.
        const folded: number[] = []
        const rewritten: number[] = []
        for (let byte = 1; byte < 128; byte++) {
          const ch = String.fromCharCode(byte)
          if (!forFile(`fold${byte}.service`).some((l) => l.includes(`'ZzProbe'`))) folded.push(byte)
          const quoted = forFile(`path${byte}.service`).join('\n').match(/not absolute, ignoring: (.*)$/)?.[1]
          if (quoted !== `SENT${ch}INEL`) rewritten.push(byte)
        }
        expect(folded, 'these characters CONTINUE the value line onto the next one').toEqual([92])
        // Rewritten: TAB and CR (stripped or split), space (a list separator in
        // ReadWritePaths=), both quotes, the % specifier and the backslash. LF (10)
        // forges a line of its own rather than rewriting one — that one is
        // asserted by the newline test above, where the forged line is the tell.
        expect(rewritten, 'these characters change the value systemd parses').toEqual([9, 10, 13, 32, 34, 37, 39, 92])

        // And the guard refuses each of them, in the shape that mangles it. The
        // space is the one value-level rule that is POSITIONAL: systemd splits a
        // list directive on it and strips it at the edges of a value, so the guard
        // refuses it at the edges only — `INSTALL_DIR='/opt/synaptomind v2'` renders,
        // and the "not a blanket ban" test above says so on the record.
        const refused: [string, string][] = [
          ['INSTALL_DIR', '/opt/synaptomind\\'],
          ...rewritten.filter((b) => b !== 32).map((b) => ['INSTALL_DIR', `/opt/x${String.fromCharCode(b)}y`] as [string, string]),
          ['INSTALL_DIR', ' /opt/synaptomind'],
          ['DATA_DIR', '/var/lib/synaptomind '],
        ]
        for (const [name, value] of refused) {
          const res = renderWithPath({}, { [name]: value })
          expect(res.status, `${name}=${JSON.stringify(value)} must be refused`).not.toBe(0)
          expect(res.stdout, `${name}=${JSON.stringify(value)} must render nothing`).toBe('')
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('the refusal side is covered with or without systemd', () => {
    // The half of the sweep that needs no systemd at all, asserted on EVERY host
    // so a skip can never cost more than the forward property. These are the same
    // eight characters the sweep MEASURES on a host that has systemd 255 —
    // TAB, LF, CR, space (at the edges), `"`, `'`, `%` and `\` — plus `#` and `;`,
    // which the guard refuses without being in that measurement because they are
    // the config parser's comment characters by construction. If the skip above
    // ever loses its reason, or the guard is narrowed, this fails.
    const mustBeRefused: [string, string][] = [
      // TAB
      ['APP_DESC', 'thought-graph engine\tproduction'],
      // LF
      ['INSTALL_DIR', '/opt/synaptomind\n'],
      // CR
      ['DATA_DIR', '/var/lib/synaptomind\r'],
      // space, at the edges only
      ['INSTALL_DIR', ' /opt/synaptomind'],
      ['DATA_DIR', '/var/lib/synaptomind '],
      // both quotes
      ['TARGET_HOME', '/home/"synaptomind'],
      ['TARGET_USER', "'root'"],
      // the % specifier
      ['INSTALL_DIR', '/opt/%I-synaptomind'],
      ['APP_DESC', 'thought-graph %n engine'],
      // backslash
      ['DATA_DIR', '/var/lib/synaptomind\\'],
      // the comment characters
      ['APP_DESC', 'thought-graph engine # production'],
      ['APP_DESC', 'thought-graph engine; production'],
      // another control character, for the class rather than the instance
      ['APP_DESC', `thought-graph engine${String.fromCharCode(1)}production`],
    ]
    for (const [name, value] of mustBeRefused) {
      const res = renderWithPath({}, { [name]: value })
      expect(res.status, `${name}=${JSON.stringify(value)} must be refused`).not.toBe(0)
      expect(res.stdout, `${name}=${JSON.stringify(value)} must render nothing`).toBe('')
      expect(res.stderr, `${name} must be named`).toContain(name)
    }
  })

  test('the sweep state of this host is stated, not implied', () => {
    // One assertion so a CI log records which of the two happened: measured
    // (every number above is real) or skipped by name (no parser to measure).
    // A silent early return produced neither.
    if (HAS_SYSTEMD_ANALYZE) {
      expect(SWEEP_SKIP_NOTE).toBe('')
    } else {
      expect(SWEEP_SKIP_NOTE).toContain('systemd-analyze is not on PATH')
    }
  })

  test('the refusal happens before anything is written or reloaded', () => {
    // A renderer that half-writes is worse than one that refuses. Same
    // recording stubs as above: a refusal must not have reached systemctl,
    // systemd-run or sudo on the way out.
    const dir = mkTempTree('synapto-render-refuse-')
    try {
      const log = makeRecordingStubs(dir)
      const res = renderWithPath(
        {},
        {
          INSTALL_DIR: '/opt/synaptomind\nReadWritePaths=/ /',
          PATH: `${dir}:${process.env.PATH}`,
          STUB_INVOCATION_LOG: log,
        },
      )
      expect(res.status).not.toBe(0)
      expect(readFileSync(log, { encoding: 'utf8' })).toBe('')
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
      // The percent this test used to assert is a REAL mangling, not a legit
      // value — but NOT the one the value it replaced proved. MEASURED against
      // systemd 255 (`ReadWritePaths=SENT<ch>INEL`, whose diagnostic quotes the
      // value systemd parsed): `%co` becomes the config-file path
      // (`SENT/r1.serviceoINEL`), `%n` silently becomes the unit name
      // (`SENTr4.serviceINEL`), and `%zz` drops the whole assignment ("Failed to
      // resolve unit specifiers …: Invalid slot"). The '100% coverage'
      // description this test carried until task #1079 was NOT mangled: its % is
      // followed by a space, which is not a specifier, so systemd passed it
      // through verbatim. The guard still refuses a % — it is per-character, and
      // a description one edit away from '%n' must not depend on the guard
      // knowing the difference — so the rule is unchanged and only the reason
      // written next to it was wrong. This description (which a unit may
      // legitimately carry) is not the percent's case.
      ['APP_DESC', 'Synaptomind — thought-graph engine (stable)'],
      // Non-ASCII is NOT refused: the em dash above is in the shipped app.env,
      // and valid UTF-8 passes through systemd's parser verbatim (measured by
      // the sweep above; only bytes 1..127 are probed, because a lone byte above
      // 127 is invalid UTF-8 and systemd rejects the whole assignment loudly).
      ['INSTALL_DIR', '/opt/synaptomind/данные'],
      ['APP_DESC', 'Synaptomind — Thought-graph engine'],
    ] as [string, string][]) {
      const unit = renderUnit({ [name]: value } as UnitOpts & Record<string, string>)
      expect(unit, name).toContain('[Service]')
      expect(unit, name).toContain('Restart=always')
    }
  })

  test.skipIf(!HAS_SYSTEMD_ANALYZE)(
    `the units systemd-analyze accepts still verify clean${SWEEP_SKIP_NOTE}`,
    () => {
      // Guard against a malformed body slipping past the substring assertions: a
      // real systemd on the machine verifies the rendered file when it is present.
      // Skipped BY NAME rather than by a bare `return` (task #1097), for the same
      // reason as the sweep above.
      const dir = mkTempTree('synapto-unit-verify-')
      try {
        const p = join(dir, 'synaptomind.service')
        writeFileSync(p, renderUnit())
        const res = spawnSync('systemd-analyze', ['verify', p], {
          encoding: 'utf8',
          timeout: 30_000,
        })
        expect(`${res.stdout}${res.stderr}`).not.toContain('Refusing')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})