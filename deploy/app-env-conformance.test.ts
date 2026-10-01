/**
 * Framework-gap conformance for every app.env that ships outside this repo.
 *
 * The deploy/ framework gained six keys' worth of generality in #1108 (health
 * contract, DATA_DIR ownership, unit extras, the source build step, per-app
 * binary file lists, a bounded stop) plus the ADR §4/§5 app.env keys that #1110
 * (ziptask, DIST=binary) and #1111 (subagentix, DIST=source) each shipped. The
 * framework's OWN suite proved the new code against synaptomind's app.env, which
 * sets NONE of them — every new key takes its `:=` default there, so a green
 * `bun test ./deploy/` says the defaults are intact and nothing about whether a
 * real app can use the feature.
 *
 * THIS file is that missing half. It takes each app's SHIPPED app.env, sandboxed
 * into a temp tree, and drives the real install.sh against it. Nothing is
 * hand-fed to the framework: the keys under test come from the file the repo
 * ships, and the only edits are the paths (INSTALL_DIR / DATA_DIR / RUN_DIR /
 * UNIT_FILE / HOOKS_DIR / EXEC_START), which is what makes it a sandbox and not
 * a re-specification.
 *
 * See ./app-targets for how targets are named (DEPLOY_APP_ENVS) and why a
 * requested-but-unresolved target fails the run instead of skipping it.
 *
 * SANDBOXING, and the two traps this file is built around:
 *
 *  1. `load_app_env()` SOURCES app.env, so a plain assignment in it beats the
 *     process environment. Both new app.envs carry `RUN_DIR=""`, and
 *     resolve_target_user() then derives the operator's REAL ~/.ziptask from
 *     `getent passwd` — the #1101 incident, where a fixture overwrote the live
 *     app.env while every assertion stayed green. So the sandbox is written INTO
 *     the app.env copy (sandboxAppEnvText), assertSandboxed() refuses any
 *     override outside the fixture root, and guardRealStateDir() fingerprints
 *     the real state dir for the whole run.
 *  2. `sudo` has its own secure PATH, so a PATH stub does NOT intercept it.
 *     A "sandboxed" demo once restarted the live service five times that way
 *     (AGENTS.md §8). sudo/systemctl are therefore stubbed for real here, and
 *     nothing privileged runs.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync as fsExistsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCoverage, guardProductionPaths, readAppEnvValues, resolveTargets, sandboxAppEnvText } from './app-targets'
import { guardRealStateDir, installCleanup, isolatedEnv, mkTempTree } from './tmp-fixtures'

installCleanup()
guardRealStateDir()

const DEPLOY_DIR = import.meta.dir
const LIB = join(DEPLOY_DIR, 'lib', 'common.sh')
const TARGETS = resolveTargets()
// Containment for the TARGETS, not just for this repo's own app: guardRealStateDir()
// watches ~/.synaptomind, which says nothing about ~/.ziptask or ~/.subagentix.
// See guardProductionPaths for why the check lives at process exit and why the
// live tracker's own data directory is excluded from the watch list.
guardProductionPaths(TARGETS.resolved)

/** POSIX single-quoting for a bash heredoc body. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The /health body both new apps actually answer with: a bare `{"ok":true}`,
 * no `status`, no `version` (ADR §3d).
 *
 * Named rather than written inline because it is a JSON document inside a shell
 * single-quoted string inside a TypeScript single-quoted string — three quoting
 * layers, and a mis-quoted one produces a parse error at best and a silently
 * different body at worst.
 */
const HEALTHY_BODY = '{"ok":true}'
/** The same contract with the ok-value flipped: must fail, or the gate is vacuous. */
const UNHEALTHY_BODY = '{"ok":false}'

/**
 * Replace ONE assignment line in an app.env text, appending it when absent.
 *
 * The function replacement is not incidental: `line` is test data that may hold
 * `$` (a glob, a value under test), and `String.replace` would read a `$pattern`
 * in it. The caller is responsible for the line being safe to SOURCE — see
 * renderUnit's rawAppEnvLines, which exists only because the fixture's own
 * quote() refuses a double quote in an override.
 */
function replaceAssignment(text: string, key: string, line: string): string {
  const re = new RegExp(`^${key}=`, 'm')
  return re.test(text) ? text.replace(re, () => line) : `${text}\n${line}\n`
}

/**
 * unit_value_defect called DIRECTLY, with the value as an ARGVUMENT.
 *
 * `bash -c <script> <name> <value>` puts the value in $1, so it never passes
 * through any shell text: what the guard is asked about is exactly what the test
 * wrote. That distinction is the whole reason this helper exists — finding #3
 * ("a double quote in a UNIT_EXTRA_ENV pair renders rc=0") came from a probe that
 * wrote the value RAW into the script, where `UNIT_EXTRA_ENV=FOO=ba"r` is a bash
 * SYNTAX error: the sourcing shell aborted on that line, the key kept its default
 * empty, and the render then succeeded on nothing. Returns what the guard PRINTS
 * ('' when it finds no defect), not an exit status — unit_value_defect reports
 * through its output.
 */
function unitValueDefect(value: string): string {
  const res = spawnSync('bash', ['-c', `. ${q(LIB)}\nunit_value_defect "$1"\n`, 'unit-value', value], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  return (res.stdout ?? '').trim()
}

let ROOT = ''
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
  ROOT = ''
})

// ── Fixture ─────────────────────────────────────────────────────────────────

/**
 * A copy of the FRAMEWORK (install.sh + lib/common.sh) with the target's real
 * app.env dropped in and every path redirected into a temp tree.
 *
 * The framework scripts come from HERE, not from the target's vendored copy: the
 * gaps under test live in this repo's copy, and a test of "does the framework
 * support X" run against a vendored copy would prove the vendor copied the
 * feature rather than that the feature works. The target contributes app.env —
 * which is the artifact these tests are actually about — plus nothing else.
 */
function seedTarget(target: { label: string; appEnvPath: string }, opts: { env?: Record<string, string> } = {}) {
  const root = ensureRoot(`conform-${target.label}-`)
  const deployDir = join(root, 'deploy')
  cpSync(DEPLOY_DIR, deployDir, {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts') && !src.endsWith('app-targets.ts'),
  })
  const installDir = join(root, 'opt')
  const dataDir = join(root, 'data')
  const runDir = join(root, 'run')
  const unitFile = join(root, 'unit', `${target.label}.service`)
  mkdirSync(join(root, 'unit'), { recursive: true })

  const overrides: Record<string, string> = {
    INSTALL_DIR: installDir,
    DATA_DIR: dataDir,
    RUN_DIR: runDir,
    HOOKS_DIR: join(runDir, 'hooks'),
    EXEC_START: `${installDir}/bin`,
    ...opts.env,
  }
  // Every path this suite redirects must land inside the fixture root. A value
  // copied verbatim out of a shipped app.env (/opt/ziptask, /var/lib/…) would
  // otherwise pass this helper and write to the host.
  assertOverridesInside(overrides, root)
  writeFileSync(join(deployDir, 'app.env'), sandboxAppEnvText(target.appEnvPath, overrides))

  return { deployDir, installDir, dataDir, runDir, unitFile, appEnvPath: join(deployDir, 'app.env') }
}

/**
 * The one temp tree a test may use, created on FIRST use.
 *
 * Lazy rather than created in an afterEach-able top-level statement because the
 * helpers that build the fixture (a git origin, a release dir, the stub bin) all
 * need the same root and are called in an order that varies per test. Every one
 * of them goes through this, so a fixture cannot accidentally build part of
 * itself outside the tree the sweep removes — which is what happened on the first
 * run: `git init` in the repo root, three untracked dirs left behind.
 */
function ensureRoot(prefix = 'deploy-conform-'): string {
  if (!ROOT) ROOT = mkTempTree(prefix)
  return ROOT
}

const SANDBOX_PATH_KEYS = ['INSTALL_DIR', 'DATA_DIR', 'RUN_DIR', 'HOOKS_DIR', 'EXEC_START'] as const

function assertOverridesInside(overrides: Record<string, string>, root: string): void {
  for (const key of SANDBOX_PATH_KEYS) {
    const value = overrides[key]
    if (!value) continue
    if (!value.startsWith(`${root}/`)) {
      throw new Error(`sandbox override ${key}=${value} is outside the fixture root ${root}`)
    }
  }
}

/**
 * sudo + systemctl stubs that LOG and do nothing.
 *
 * `execSudo` is off by default: a logging sudo writes nothing, which is what
 * keeps the "nothing outside the fixture changed" claim cheap. A test that needs
 * a file to actually appear turns it on, and the stub then refuses any path
 * outside the fixture root rather than trusting its caller.
 */
function seedPrivStubs(root: string, opts: { execSudo?: boolean; chownSnapshot?: boolean } = {}) {
  const stubsDir = join(root, 'stubs')
  const log = join(root, 'privileged.log')
  mkdirSync(stubsDir, { recursive: true })
  writeFileSync(log, '')
  for (const name of ['sudo', 'systemctl']) {
    const lines = ['#!/usr/bin/env bash', 'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"', 'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done', 'printf \'\\n\' >> "$STUB_PRIV_LOG"']
    if (name === 'systemctl') {
      lines.push('[ "$1" = "is-system-running" ] && echo running')
    } else if (opts.execSudo) {
      lines.push(
        'for a in "$@"; do',
        '  case "$a" in',
        '    /*)',
        // Allowed: the fixture root (where the unit lives) AND the host tmpdir,
        // because install.sh renders the unit into `mktemp -d` and then `cp`s it
        // into the staging file beside the unit. Without the tmpdir arm that cp is
        // REFUSED (exit 99), and the run reports `cannot write the replacement
        // into …/unit` followed by "Service: skipped" — a fixture defect that
        // reads exactly like a framework defect.
        `      case "$a" in ${root}/*|"${tmpdir()}"/*) ;; *) echo "STUB: refused path $a" >&2; exit 99 ;; esac`,
        '      ;;',
        '  esac',
        'done',
        'case "${1:-}" in',
        // chown is here because it IS the command under test: apply_ownership
        // issues it through run_root, and a stub that refused it would make
        // every "cannot chown" assertion pass for the wrong reason — the
        // refusal would be the stub's, not the unprivileged install's. The
        // refusal path has its own stub (refuseChownInSudoStub).
        '  touch|chmod|cp|mv|rm|install|systemctl|mkdir|ln|chown) ;;',
        '  *) echo "STUB: refused command ${1:-}" >&2; exit 99 ;;',
        'esac',
      )
      if (opts.chownSnapshot) {
        // What was in each chowned directory AT THE MOMENT the chown ran, as one
        // `LS <dir>:a,b,c` line per absolute argument. The ordering claim of
        // apply_run_dir_ownership — "it runs after the helper installers, or it
        // chowns an empty directory" — is only observable from inside the run: a
        // log of calls cannot tell a chown of a not-yet-created directory from a
        // chown of an empty one, and both are the defect.
        lines.push(
          'case "${1:-}" in',
          '  chown)',
          '    for d in "$@"; do',
          '      case "$d" in',
          '        /*)',
          '          printf \'LS %s:\' "$d" >> "$STUB_PRIV_LOG"',
          '          ls -1 "$d" 2>/dev/null | tr \'\\n\' \',\' >> "$STUB_PRIV_LOG"',
          '          printf \'\\n\' >> "$STUB_PRIV_LOG"',
          '          ;;',
          '      esac',
          '    done',
          '    ;;',
          'esac',
        )
      }
      lines.push('exec "$@"')
    } else {
      lines.push(':', 'exit 0')
    }
    lines.push('exit 0')
    const path = join(stubsDir, name)
    writeFileSync(path, lines.join('\n'))
    chmodSync(path, 0o755)
  }
  return { stubsDir, log }
}

function privCalls(log: string): string[] {
  const raw = readFileSync(log, 'utf8').trim()
  return raw ? raw.split('\n') : []
}

/**
 * A `stat` stub that reports a DIFFERENT owner for the fixture trees.
 *
 * WHY THIS IS NEEDED. apply_ownership() skips a chown that would change nothing
 * (`install.sh:407` compares `stat -c '%U:%G'` against TARGET_USER:TARGET_GROUP
 * and `continue`s when they match). A fixture tree created by the test runner is
 * owned by the runner — who is also TARGET_USER — so the shipped code correctly
 * issues NO chown at all, and an assertion that a chown was issued would fail
 * against correct behaviour.
 *
 * Making the fixture tree look root-owned is what puts the run on the branch the
 * gap added. Only the `%U:%G` format is intercepted: `%a` (mode) is used by the
 * unit writer to preserve an operator's 600, and forwarding everything else keeps
 * that path real. A stub that answered `%a` with a fixed value would silently
 * change what mode the installed unit gets.
 */
function seedForeignOwnerStat(stubsDir: string): void {
  const path = join(stubsDir, 'stat')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      '  if [ "$a" = "%U:%G" ]; then printf \'root:root\\n\'; exit 0; fi',
      'done',
      // Everything else (notably `-L -c %a`) is the REAL stat.
      `exec /usr/bin/stat "$@"`,
    ].join('\n'),
  )
  chmodSync(path, 0o755)
}

/**
 * Rewrite the sudo stub so every `chown` fails, as an unprivileged install does.
 *
 * The logging line is kept, so a test can still see that chown was ATTEMPTED —
 * otherwise "no warning" and "never tried" would be indistinguishable, which is
 * exactly what would make the non-fatal assertion below vacuous.
 */
function refuseChownInSudoStub(stubsDir: string): void {
  const stub = join(stubsDir, 'sudo')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"',
      'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
      'printf \'\\n\' >> "$STUB_PRIV_LOG"',
      'case "${1:-}" in chown) echo "chown: cannot change ownership: Operation not permitted" >&2; exit 1 ;; esac',
      'exit 0',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
}

/**
 * A curl stub that answers BOTH kinds of request an install makes:
 *   - the release asset (a `file://` URL) → copies the fixture tarball to the
 *     `-o` target, because `binary_stage_payload` downloads it with real curl and
 *     then extracts with real tar;
 *   - the health URL → prints `body`.
 *
 * Both branches are needed. A stub that answered only the health URL made the
 * binary install fail at `tar: cannot open … No such file` — a fixture defect
 * that looked exactly like a framework defect, and cost a full round of
 * debugging before the log line showed it.
 */
function seedHealthStub(stubsDir: string, body: string, opts: { log?: string; asset?: string } = {}) {
  const path = join(stubsDir, 'curl')
  const lines = [
    '#!/usr/bin/env bash',
    'url=""; out=""; prev=""',
    'for a in "$@"; do',
    '  case "$a" in *://*) url="$a" ;; esac',
    '  if [ "$prev" = "-o" ]; then out="$a"; fi',
    '  prev="$a"',
    'done',
  ]
  if (opts.log) lines.push(`printf '%s\\n' "$url" >> ${q(opts.log)}`)
  lines.push('case "$url" in')
  if (opts.asset) {
    lines.push(
      `  file://*) cp ${q(opts.asset)} "\$out"; exit \$? ;;`,
      `  *) printf '%s' ${q(body)}; exit 0 ;;`,
      'esac',
    )
  } else {
    lines.push(`  *) printf '%s' ${q(body)}; exit 0 ;;`, 'esac')
  }
  writeFileSync(path, lines.join('\n'))
  chmodSync(path, 0o755)
}

/**
 * Run install.sh out of the sandboxed deploy tree.
 *
 * `--no-service` is never passed: the unit-rendering and the ordering assertions
 * below depend on the service phase actually running. What keeps that safe is
 * the stub layer, not a flag — sudo and systemctl are stubs (a PATH stub does
 * NOT cover sudo, whose secure_path is its own; see the header), UNIT_FILE points
 * inside the fixture, and guardRealStateDir() fails the run if the operator's
 * real state dir moved.
 */
function runInstall(
  fx: ReturnType<typeof seedTarget>,
  stubsDir: string,
  privLog: string,
  args: string[] = [],
  extra: Record<string, string> = {},
) {
  return spawnSync('bash', [join(fx.deployDir, 'install.sh'), ...args], {
    encoding: 'utf8',
    env: isolatedEnv(ROOT, {
      PATH: `${stubsDir}:${process.env.PATH}`,
      STUB_PRIV_LOG: privLog,
      APP_ENV_URL: '',
      LIB_RAW_URL: '',
      // UNIT_FILE is the TARGET's, not isolatedEnv()'s. That helper pins
      // `…/unit/synaptomind.service` because the framework suite is
      // synaptomind's; app.env cannot carry the key either (no app.env declares
      // it — it is an environment override by design, install.sh:499), so a
      // target's install would otherwise write a unit named after THIS repo's
      // app and every service assertion would read a file the target never had.
      // Observed directly: the ziptask run reported
      // `not replaced: …/unit/synaptomind.service` and then "Service: skipped".
      UNIT_FILE: fx.unitFile,
      // A short health budget: the curl stub answers on the first poll, and a
      // test that reaches a FAILING gate should fail on the assertion rather
      // than on the shipped 60 s wait.
      HEALTH_TIMEOUT: '2',
      HEALTH_CONFIRM_TIMEOUT: '1',
      ...extra,
    }),
    cwd: ROOT,
    timeout: 90_000,
  })
}

// ══════════════════════════════════════════════════════════════════════════════
//  Gap coverage — always runs, against whatever DEPLOY_APP_ENVS named
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Labels of the targets some test below actually asserts against.
 *
 * Recorded at DECLARATION time, not inside a `test()` body. The coverage check
 * runs FIRST, and every `exercised.push()` that lived inside a test body was
 * therefore still empty when it ran — so it failed with "named ziptask,
 * subagentix but no test exercised it" on a suite where every target WAS
 * exercised. The check is about which targets this file registers suites for,
 * which is a property of the file, not of run order.
 */
const exercised: string[] = []

function declareExercised(targets: readonly { label: string }[]): void {
  for (const t of targets) if (!exercised.includes(t.label)) exercised.push(t.label)
}

describe('deploy/app-targets — coverage of the requested targets', () => {
  test('every target DEPLOY_APP_ENVS named was actually exercised below', () => {
    // Placed first so a target that never gets exercised is reported by the
    // suite itself rather than by whoever reads the skip count.
    checkCoverage(TARGETS, exercised)
    if (TARGETS.requested.length === 0) {
      expect(TARGETS.resolved).toEqual([])
      return
    }
    expect(TARGETS.resolved.length).toBeGreaterThan(0)
  })

  test('unresolved entries are only tolerated for a genuinely absent app', () => {
    // A DEPLOY_APP_ENVS path that exists but is not a deploy/ tree is a typo and
    // must fail; one that does not exist at all is "this machine has no such
    // app", which is reported here so it is never mistaken for a pass.
    for (const entry of TARGETS.unresolved) {
      expect(entry).toMatch(/\(not an absolute path\)|\(no app\.env\)|\(no install\.sh\)/)
    }
  })
})

// ── Per-target: the keys the app.env must carry, and the paths it must not ───

describe('deploy/app.env — the shipped key contract', () => {
  for (const target of TARGETS.resolved) {
  declareExercised(TARGETS.resolved)
    test(`${target.label}: declares the keys its mode depends on, all inside a sandbox`, () => {
      const values = readAppEnvValues(target.appEnvPath)
      const binary = values.DIST === 'binary'
      const source = values.DIST === 'source'

      // The mode itself, first: every assertion below reads differently
      // depending on it, so a wrong DIST must not silently pick a branch.
      expect(binary || source, `${target.label} DIST is ${JSON.stringify(values.DIST)}`).toBe(true)

      // Identity + the health contract. These three are what let an app whose
      // /health is `{"ok":true}` pass the gate at all (ADR §3d); without them the
      // install fails at its OWN health check on every run.
      expect(values.APP_NAME).toBe(target.label)
      expect(values.HEALTH_STATUS_FIELD, 'HEALTH_STATUS_FIELD must not be blank — blank falls back to "status"').not.toBe('')
      expect(values.HEALTH_OK_VALUES).not.toBe('')
      expect(values.HEALTH_VERSION_FIELD, 'the key must be PRESENT: empty disables the version check').toBe('')

      // Canonical layout (ADR §4/§5): code under /opt/<app>, data under
      // /var/lib/<app>, state under ~/.<app>. These are the HOST paths the
      // shipped app.env names; the sandbox rewrites them, so asserting them here
      // is what proves the rewrite is necessary and not cosmetic.
      expect(values.INSTALL_DIR).toBe(`/opt/${target.label}`)
      expect(values.DATA_DIR).toBe(`/var/lib/${target.label}`)
      expect(values.RUN_DIR, 'an empty RUN_DIR is the documented "derive from HOME" form').toBe('')

      if (source) {
        // The source build pair. INSTALL_FLAGS must not carry --production when
        // a build is configured: a build needs devDependencies, and installing
        // production-only deps first makes it fail on a missing bundler.
        expect(values.INSTALL_FLAGS).not.toContain('--production')
        expect(values.BUILD_CMD, 'a source app that ships no BUILD_CMD cannot build').not.toBe('')
        expect(Number(values.BUILD_TIMEOUT)).toBeGreaterThan(0)
      }

      if (binary) {
        // The per-app binary lists. Without them the payload check looks for
        // synaptomind's own file names, which #1110 measured as a hard abort:
        // "release payload is incomplete: missing synaptomind".
        for (const key of ['BINARY_SUPPORTED_PLATFORMS', 'BINARY_REQUIRED_FILES', 'BINARY_ROLLBACK_FILES', 'BINARY_SWAP_ORDER']) {
          expect(values[key], `${target.label} ${key} is required for DIST=binary`).toBeTruthy()
        }
        for (const key of ['BINARY_REQUIRED_FILES', 'BINARY_ROLLBACK_FILES', 'BINARY_SWAP_ORDER']) {
          for (const file of values[key].split(/\s+/)) {
            expect(file, `${key} names ${target.label}'s own artefact`).toBe(target.label)
          }
        }
        // Single-quoted on purpose, so render_template() still has a ${TAG} to
        // substitute. A double-quoted value is expanded at SOURCE time and the
        // asset pattern arrives already collapsed.
        expect(values.ASSET_PATTERN).toContain('${TAG}')
        expect(values.ASSET_PATTERN).toContain('${APP_NAME}')
      }
    })
  }
})

// ── Gap (a): the health contract, per app.env ───────────────────────────────
//
// Driven against the real lib/common.sh with the target's real health keys,
// and the bodies those keys are FOR: `{"ok":true}` for the two new apps. Each
// variant is paired with a negative control, because a health gate that accepts
// everything is the vacuous pass these keys exist to prevent.

describe('deploy/health contract — one gate, several contracts', () => {
  /** wait_health against a scripted body, with the target's own health keys. */
  function runGate(target: { label: string; appEnvPath: string }, body: string, opts: { keys?: Record<string, string>; expected?: string } = {}) {
    const dir = mkTempTree('gate-')
    // The sandboxed app.env goes to a FILE and is sourced from there. Inlining
    // the text into the script (`. "$text"`) sources it as a FILENAME, which
    // fails with "No such file or directory" — and then every key silently keeps
    // its framework default. That is the worst shape of bug this file could have:
    // the "the app's keys pass {"ok":true}" test would have been asserting the
    // DEFAULTS, and the negative control below would have been the only thing
    // standing between a broken suite and a green one.
    const appEnvFile = join(dir, 'app.env')
    writeFileSync(
      appEnvFile,
      sandboxAppEnvText(target.appEnvPath, {
        INSTALL_DIR: join(dir, 'opt'),
        DATA_DIR: join(dir, 'data'),
        RUN_DIR: join(dir, 'run'),
        ...opts.keys,
      }),
    )
    const script = `
. ${q(LIB)}
. ${q(appEnvFile)}
APP_NAME=${q(target.label)}
TARGET_USER=$(id -un)
url_get() { printf '%s' ${q(body)}; return 0; }
wait_health "http://127.0.0.1:1/health" ${q(opts.expected ?? '')} 1
__rc=$?
# '-<unset>', NOT ':-<unset>': an empty HEALTH_FAILURE is the SUCCESS value, and
# the ':' form substitutes for empty too — so a passing gate would read as
# "<unset>" and the pass/fail pair could not be told apart.
printf 'HEALTH_FAILURE=%s\\n' "\${HEALTH_FAILURE-<unset>}"
exit $__rc
`
    try {
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
      return {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        // A source that fails (a missing file, a bad key) leaves no marker at
        // all, which must be distinguishable from the empty SUCCESS value.
        failure: /HEALTH_FAILURE=(.*)/.exec(res.stdout)?.[1] ?? '<no marker>',
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const target of TARGETS.resolved) {
  declareExercised(TARGETS.resolved)
    test(`${target.label}: {"ok":true} passes the gate, with ONE version-disabled warning`, () => {
      const gate = runGate(target, HEALTHY_BODY)
      expect(gate.status, gate.stdout + gate.stderr).toBe(0)
      expect(gate.failure).toBe('')
      // The warning is the whole point of the empty HEALTH_VERSION_FIELD: a
      // missing contract reported by silence is a vacuous pass. Exactly ONE, so
      // an operator sees a stated caveat rather than a wall of noise.
      const warnings = gate.stderr.split('\n').filter((l) => l.includes('version check is DISABLED'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(target.label)
    })

    test(`${target.label}: {"ok":false} is rejected as a contract failure`, () => {
      const gate = runGate(target, UNHEALTHY_BODY)
      expect(gate.status).toBe(1)
      expect(gate.failure).toBe('contract')
    })

    test(`${target.label}: the framework DEFAULTS reject {"ok":true} — the keys are load-bearing`, () => {
      // Negative control. Under synaptomind's defaults (status / ok degraded /
      // version) the very same body is a CONTRACT failure: the app's three keys
      // are what make this cutover possible, not decoration.
      const gate = runGate(target, HEALTHY_BODY, {
        keys: { HEALTH_STATUS_FIELD: 'status', HEALTH_OK_VALUES: 'ok degraded', HEALTH_VERSION_FIELD: 'version' },
      })
      expect(gate.status).toBe(1)
      expect(gate.failure).toBe('contract')
    })

    test(`${target.label}: a wrong ok-value under the app's own keys still fails`, () => {
      // The other half of non-vacuity: not "any JSON passes", but "the declared
      // value passes and a different one does not".
      const gate = runGate(target, '{"ok":"yes"}')
      expect(gate.status).toBe(1)
      expect(gate.failure).toBe('contract')
    })

    test(`${target.label}: an unreadable contract is refused BEFORE the payload is fetched`, () => {
      // A health field name that is not a plain JSON key is interpolated into a
      // sed pattern; the gate refuses it rather than reading whatever that
      // pattern matches.
      // The bad value goes into the SANDBOXED app.env, not the process
      // environment: load_app_env() SOURCES app.env, so an env override would be
      // discarded by the very file that carries the app's real keys.
      const fx = seedTarget(target, { env: { HEALTH_STATUS_FIELD: 'a|b*c' } })
      const { stubsDir, log } = seedPrivStubs(ensureRoot())
      seedHealthStub(stubsDir, HEALTHY_BODY)
      const res = runInstall(fx, stubsDir, log, [])
      expect(res.status, res.stdout + res.stderr).not.toBe(0)
      expect(res.stderr + res.stdout).toContain('HEALTH_STATUS_FIELD')
      expect(res.stderr + res.stdout).toMatch(/not a JSON key/)
      // And it refused before writing anything: require_health_contract is
      // called from main() before the payload is fetched, which is the whole
      // point of doing it there — the host is still untouched when the refusal
      // lands.
      expect(existsSyncSafe(fx.installDir), 'INSTALL_DIR exists, so the payload was fetched').toBe(false)
    })
  }
})

// ── Gap (b): INSTALL_DIR / DATA_DIR ownership ───────────────────────────────
//
// Before apply_ownership(), `grep -n chown deploy/*.sh` returned one hit and it
// was a WARNING STRING — nothing in the framework applied ownership at all. The
// failure it prevents is invisible to the health gate: a root-owned DATA_DIR
// makes the service's first WRITE fail, long after the check passed.

describe('deploy/apply_ownership — both trees, before the service starts', () => {
  for (const target of TARGETS.resolved) {
  declareExercised(TARGETS.resolved)
    /**
     * A full install for the target's own mode: a real git origin for
     * DIST=source, a real release tarball for DIST=binary, `bun` stubbed only
     * where a build would otherwise install a node_modules.
     *
     * Everything below the payload (seed, data dir, ownership, unit, start) is
     * what these tests are about, so the fixture has to genuinely REACH it — a
     * `--no-service` run that stopped at the clone would report no chown and the
     * assertion would be measuring the fixture rather than the framework.
     */
    function fullInstall(opts: { execSudo?: boolean; refuseChown?: boolean; chownSnapshot?: boolean } = {}) {
      const values = readAppEnvValues(target.appEnvPath)
      const binary = values.DIST === 'binary'
      const origin = binary ? null : seedGitOrigin(target.label)
      const release = binary ? seedReleaseDir(target.label) : null
      const env: Record<string, string> = binary
        ? { RELEASES_BASE: `file://${release!.dir}`, RELEASE_API: '' }
        : { REPO_URL: origin!.url, CHECKOUT_POLICY: 'stable' }
      const fx = seedTarget(target, { env })
      const { stubsDir, log } = seedPrivStubs(ensureRoot(), { execSudo: opts.execSudo, chownSnapshot: opts.chownSnapshot })
      // A root-owned-looking tree, so apply_ownership takes the branch it added
      // instead of correctly skipping a no-op chown.
      seedForeignOwnerStat(stubsDir)
      if (opts.refuseChown) refuseChownInSudoStub(stubsDir)
      if (!binary) seedBunStub(stubsDir, join(ensureRoot(), 'bun.log'))
      // For a binary install the SAME curl stub must serve the asset too, or the
      // run dies in tar before reaching anything these tests are about.
      seedHealthStub(stubsDir, HEALTHY_BODY, { asset: release ? join(release.dir, release.tag, `${target.label}-${release.tag}-linux-x86_64.tar.gz`) : undefined })
      const args = binary ? ['--version', release!.tag] : ['--version', origin!.tag]
      const res = runInstall(fx, stubsDir, log, args)
      return { res, log, stubsDir, origin, release, binary, fx }
    }

    test(`${target.label}: chowns INSTALL_DIR and DATA_DIR to the unit's user`, () => {
      const { res, log } = fullInstall({ execSudo: true })
      expect(res.status, res.stdout + res.stderr).toBe(0)

      const calls = privCalls(log)
      const chowns = calls.filter((c) => c.includes('chown') && c.includes('-R'))
      expect(chowns.length, `no recursive chown in:\n${calls.join('\n')}`).toBeGreaterThanOrEqual(2)
      // Both trees, and named by path — the whole point of the gap, since
      // DATA_DIR is where the service writes.
      for (const dir of [join(ROOT, 'opt'), join(ROOT, 'data')]) {
        expect(chowns.some((c) => c.includes(` ${dir}`)), `no chown for ${dir} in:\n${calls.join('\n')}`).toBe(true)
      }
      // To the user the unit runs as, not root and not an empty field.
      const me = process.env.USER ?? 'root'
      for (const call of chowns) expect(call).toContain(`${me}:`)
    })

    test(`${target.label}: ownership is applied BEFORE the unit is started`, () => {
      const { res, log } = fullInstall({ execSudo: true })
      expect(res.status, res.stdout + res.stderr).toBe(0)
      const calls = privCalls(log)
      const lastChown = calls.findLastIndex((c) => c.includes('chown') && c.includes('-R'))
      const firstStart = calls.findIndex((c) => c.includes('systemctl') && c.includes(' restart '))
      expect(lastChown, 'no chown was issued at all').toBeGreaterThanOrEqual(0)
      expect(firstStart, `no systemctl restart in:\n${calls.join('\n')}\n--- install output ---\n${res.stdout}\n${res.stderr}`).toBeGreaterThan(lastChown)
    })

    test(`${target.label}: a chown that FAILS warns and the install still finishes`, () => {
      // NOT FATAL by decision (ADR §3c): a --dir install under the caller's own
      // home has nothing to chown, and aborting there would turn an ownership
      // cosmetic into a failed install. The refusal is injected at the stub, so
      // everything else about the run is the ordering that ships.
      const { res } = fullInstall({ refuseChown: true })
      expect(res.status, res.stdout + res.stderr).toBe(0)
      expect(res.stdout).toContain('Done.')
      // The mismatch is named, with the consequence and a fix — not swallowed.
      expect(res.stderr).toContain('cannot chown')
      expect(res.stderr).toMatch(/EACCES/)
      expect(res.stderr).toMatch(/fix: sudo chown/)
    })

    test(`${target.label}: chowns RUN_DIR, scripts/ and hooks/ AFTER the helper installers wrote them`, () => {
      // The RUN_DIR half of the gap (#1113): the pre-update hook runs as
      // TARGET_USER and reads ${RUN_DIR}/scripts/app.env, which is installed
      // mode 600 — so a root-owned one is unreadable to exactly the process that
      // takes the pre-update database backup, and the backup fails silently.
      //
      // The ORDERING is the part that cannot be asserted from a call log: a chown
      // of a directory that does not exist yet and a chown of an empty one look
      // identical there. So the sudo stub records what was in each chowned
      // directory at the moment it was chowned (chownSnapshot), and the helpers
      // must already be in place — otherwise apply_run_dir_ownership is
      // chowning an empty tree and the fix is decoration.
      const { res, log, fx } = fullInstall({ execSudo: true, chownSnapshot: true })
      expect(res.status, res.stdout + res.stderr).toBe(0)
      const calls = privCalls(log)
      const chowns = calls.filter((c) => c.includes('chown') && c.includes('-R'))
      for (const dir of [fx.runDir, join(fx.runDir, 'scripts'), join(fx.runDir, 'hooks')]) {
        expect(chowns.some((c) => c.includes(` ${dir}`)), `no chown for ${dir} in:\n${calls.join('\n')}`).toBe(true)
      }
      // Scoped: RUN_DIR may also hold app state the framework does not own, so a
      // blind `chown -R ${RUN_DIR}` would silently take that too.
      const owned = chowns.map((c) => c.trim().split(/\s+/).pop())
      expect(owned.filter((p) => p?.startsWith(fx.runDir)).sort()).toEqual(
        [fx.runDir, join(fx.runDir, 'hooks'), join(fx.runDir, 'scripts')].sort(),
      )
      // And the files were already there when the chown ran.
      const snapshot = (dir: string) => calls.find((c) => c.startsWith(`LS ${dir}:`))
      const scripts = snapshot(join(fx.runDir, 'scripts'))
      expect(scripts, `no snapshot of ${join(fx.runDir, 'scripts')} in:\n${calls.join('\n')}`).toBeDefined()
      for (const helper of ['app.env', 'common.sh', 'update.sh', 'updater.sh', 'uninstall.sh']) {
        expect(scripts, `${helper} was not installed yet when scripts/ was chowned`).toContain(helper)
      }
      const hooks = snapshot(join(fx.runDir, 'hooks'))
      expect(hooks, `no snapshot of ${join(fx.runDir, 'hooks')} in:\n${calls.join('\n')}`).toContain('pre-update')
      // The mode-600 app.env is the whole reason this pass exists.
      expect(statSync(join(fx.runDir, 'scripts', 'app.env')).mode & 0o777).toBe(0o600)
    })
  }
})

/**
 * A `file://` release directory holding one asset, for a DIST=binary target.
 *
 * The payload carries the app's OWN artefact name, so a pass here means the
 * per-app BINARY_* list is honoured rather than that the framework happened to
 * find synaptomind's names. `root` is explicit (not the shared fixture root)
 * because the BINARY_* staging tests need an isolated release tree of their own.
 */
function seedReleaseDirIn(root: string, label: string): { dir: string; tag: string } {
  const tag = 'v9.9.9-test'
  const version = '9.9.9-test'
  const asset = `${label}-${tag}-linux-x86_64.tar.gz`
  const topDir = `${label}-${version}-linux-x86_64`
  const stage = join(root, '.payload', topDir)
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, label), `#!/bin/sh\necho "${label} ${version}"\n`)
  chmodSync(join(stage, label), 0o755)
  const dir = join(root, 'releases')
  mkdirSync(join(dir, tag), { recursive: true })
  const tar = spawnSync('tar', ['-czf', join(dir, tag, asset), '-C', join(root, '.payload'), topDir], {
    encoding: 'utf8',
  })
  expect(tar.status, tar.stderr).toBe(0)
  return { dir, tag }
}

/** seedReleaseDirIn against the shared fixture root. */
function seedReleaseDir(label: string): { dir: string; tag: string } {
  return seedReleaseDirIn(ensureRoot(), label)
}

// ── Gap (c): the unit extras ────────────────────────────────────────────────
//
// StateDirectory= / EnvironmentFile= / Environment= are rendered ONLY when the
// key is non-empty, and every substituted value goes through assert_unit_value.
// The guard is the interesting half: a value systemd's parser would fold is
// DROPPED IN SILENCE, so the app runs without the variable and nothing says so.
//
// The unit extras are also the one place where the guard runs on a SPLIT value:
// UNIT_EXTRA_ENV is a space-separated blob of "K=V" pairs, and since #1117
// render_systemd_unit splits it on a space BY HAND rather than through an
// unquoted `for` (which split on IFS first, so no pair could ever contain a line
// break and the newline arm of unit_value_defect was unreachable). The split is
// the part under test below, because "the value is refused" and "the value was
// shredded into several valid ones" are the same green result unless the message
// and the pair count are both asserted.

describe('deploy/unit extras — rendering and rejection', () => {
  /**
   * render_systemd_unit against a sandboxed app.env, returning the body.
   *
   * `cwd` is the FIXTURE's directory, never the repo root. Nothing here depends on
   * it until the pathname-expansion case, and that case is precisely a claim about
   * which directory the render reads — a render run in the repo root would prove
   * something about the repo, not about the value.
   *
   * `rawAppEnvLines` bypasses sandboxAppEnvText for a named key, and exists for
   * ONE reason: that helper's quote() refuses `"`, `$` and a backtick in an
   * override, because they change meaning inside the double quotes every app.env
   * line uses. A test whose subject IS such a value therefore has to write the
   * line itself — in the form an operator writes it, escaped. It is refused for
   * the path keys, which keep the containment check; a non-path key cannot name a
   * file to write.
   */
  function renderUnit(
    target: { label: string; appEnvPath: string },
    keys: Record<string, string> = {},
    opts: { rawAppEnvLines?: Record<string, string>; files?: readonly string[] } = {},
  ) {
    const dir = mkTempTree('unit-')
    // A FILE, sourced — never the text inlined into the script. See runGate.
    const appEnvFile = join(dir, 'app.env')
    let appEnvText = sandboxAppEnvText(target.appEnvPath, {
      INSTALL_DIR: join(dir, 'opt'),
      DATA_DIR: join(dir, 'data'),
      RUN_DIR: join(dir, 'run'),
      ...keys,
    })
    for (const [key, line] of Object.entries(opts.rawAppEnvLines ?? {})) {
      if ((SANDBOX_PATH_KEYS as readonly string[]).includes(key)) {
        throw new Error(`rawAppEnvLines may not carry the sandboxed path key ${key}`)
      }
      appEnvText = replaceAssignment(appEnvText, key, line)
    }
    writeFileSync(appEnvFile, appEnvText)
    for (const name of opts.files ?? []) writeFileSync(join(dir, name), 'x\n')
    const script = `
. ${q(LIB)}
. ${q(appEnvFile)}
APP_NAME=${q(target.label)}
TARGET_USER=$(id -un)
TARGET_GROUP=$TARGET_USER
TARGET_HOME=$HOME
BUN_BIN=""
render_systemd_unit ${q(keys.EXEC_START ?? '/opt/app/bin')}
__rc=$?
printf 'RENDER_RC=%s\\n' "$__rc"
exit 0
`
    try {
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, cwd: dir })
      const rc = /RENDER_RC=(\d+)/.exec(res.stdout)?.[1] ?? '?'
      const body = res.stdout.slice(0, res.stdout.indexOf('RENDER_RC='))
      return { rc, body, stderr: res.stderr }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const target of TARGETS.resolved) {
  declareExercised(TARGETS.resolved)
    const values = readAppEnvValues(target.appEnvPath)

    test(`${target.label}: renders exactly the extras its app.env asks for`, () => {
      const { rc, body } = renderUnit(target)
      expect(rc, 'render_systemd_unit refused its own app.env').toBe('0')

      // Present iff asked for. The paired absence is the half that matters: a
      // template that always emitted these would have changed every existing
      // app's unit, and an assertion on presence alone would not notice.
      //
      // The values come from the app.env itself, and a key the app does not
      // declare reads as '' — the framework's documented "rendered only when
      // non-empty" default, not an absent lookup. ziptask declares none of the
      // three, subagentix declares all three, and both directions are asserted.
      const stateDir = values.UNIT_STATE_DIRECTORY ?? ''
      const envFile = values.UNIT_ENV_FILE ?? ''
      const extraEnv = values.UNIT_EXTRA_ENV ?? ''

      if (stateDir) {
        expect(body).toContain(`StateDirectory=${stateDir}`)
        // 0700, not the systemd default 0755: the app resolves its state through
        // this variable and writes a settings file into it.
        expect(body).toContain('StateDirectoryMode=0700')
      } else {
        expect(body).not.toContain('StateDirectory=')
      }

      if (envFile) expect(body).toContain(`EnvironmentFile=${envFile}`)
      else expect(body).not.toContain('EnvironmentFile=')

      const pairs = extraEnv.split(/\s+/).filter(Boolean)
      for (const pair of pairs) {
        expect(body, `UNIT_EXTRA_ENV pair ${pair} did not reach the unit`).toContain(`Environment=${pair}`)
      }
      if (pairs.length === 0) {
        // The framework's OWN lines and nothing else. Asserting the exact set is
        // what proves the app's missing keys add NOTHING — an empty Environment=
        // line would pass a "value not present" check.
        //
        // LD_LIBRARY_PATH is the framework's own line too, and DIST decides it:
        // it is emitted for DIST=binary only (ADR §2.2, so a compiled payload can
        // dlopen its embedded addon). Keying the expectation on DIST rather than
        // hardcoding it is what keeps this correct for an app of either mode.
        const own = ['NODE_ENV', 'HOME', 'PATH', ...(values.DIST === 'binary' ? ['LD_LIBRARY_PATH'] : [])]
        const envLines = body.split('\n').filter((l) => l.startsWith('Environment='))
        const ownLines = envLines.filter((l) => own.some((k) => l.startsWith(`Environment=${k}=`)))
        expect(envLines, `unexpected Environment= lines:\n${envLines.join('\n')}`).toEqual(ownLines)
        expect(ownLines).toContain(`Environment=HOME=${process.env.HOME ?? ''}`)
        // And the mode actually decided it, rather than the list being right by
        // coincidence: ziptask (binary) has the line, subagentix (source) must not.
        if (values.DIST === 'binary') expect(body).toContain('Environment=LD_LIBRARY_PATH=')
        else expect(body).not.toContain('Environment=LD_LIBRARY_PATH=')
      }
    })

    test(`${target.label}: the bounded stop is rendered, and the unit carries no backtick`, () => {
      // A backtick inside the rendered body would be executed by the UNQUOTED
      // heredoc this template used to be. systemd-unit.test.ts asserts the
      // absence with execution stubs; this asserts the same property from the
      // app.env side, so a new app cannot reintroduce it through its own keys.
      const { rc, body } = renderUnit(target)
      expect(rc).toBe('0')
      // TimeoutStopSec is the BOUND; the SIGKILL that enforces it is systemd's
      // own default (SendSIGKILL=yes), which arrives only once the bound expires.
      // KillSignal must therefore NOT be set: it used to be SIGKILL, which
      // replaced the app's SIGTERM handler (src/index.ts:123 — the WAL
      // checkpoint) with an immediate unblockable kill, so every stop ended in
      // status=9 and the shutdown path never ran (#1124/#1125). Asserting the
      // ABSENCE is the contract now: a future edit that re-adds the line fails
      // here instead of re-breaking every graceful stop on the host.
      expect(body).toContain('TimeoutStopSec=15')
      expect(body).not.toContain('KillSignal=')
      expect(body).toContain('Restart=always')
      expect(body).not.toContain('`')
      expect(body).not.toContain('$(systemctl')
    })

    test(`${target.label}: Group= names the group the tree was chowned to`, () => {
      // The install chowns to TARGET_USER:TARGET_GROUP and the unit then runs as
      // that same pair; before this, the unit left the group to systemd's lookup.
      const { body } = renderUnit(target)
      expect(body).toContain(`Group=${process.env.USER ?? 'root'}`)
    })

    // ── assert_unit_value ──
    // A newline is the sharpest case: systemd reads the text after the first `=`
    // as a fresh directive, so `UNIT_STATE_DIRECTORY=a\nExecStartPre=/bin/rm`
    // would forge a line. For the two path-shaped keys the value is substituted
    // whole, so the guard sees the line break and refuses.
    for (const key of ['UNIT_STATE_DIRECTORY', 'UNIT_ENV_FILE'] as const) {
      test(`${target.label}: ${key} with a value systemd would fold is REFUSED, and no unit is printed`, () => {
        const { rc, body, stderr } = renderUnit(target, { [key]: 'app\nExecStartPre=/bin/rm -rf /' })
        expect(rc, `render accepted a newline-bearing ${key}`).not.toBe('0')
        // The contract is that it returns 1 WITHOUT printing a partial body: a
        // half-written unit is what the caller would install.
        expect(body).not.toContain('[Service]')
        expect(body).not.toContain('ExecStartPre')
        // And it says which key and what is wrong with it.
        expect(stderr).toContain(key)
        expect(stderr).toMatch(/line break/)
      })
    }

    test(`${target.label}: UNIT_EXTRA_ENV is guarded PER PAIR, so one bad pair refuses the render and names itself`, () => {
      // The guard is deliberately per pair: a whole-blob guard would always fire
      // (a blob is whitespace by construction) and an operator would learn to
      // ignore it. So a blob with a valid pair and a hostile one must REFUSE —
      // with the refusal naming the offending pair rather than dropping it.
      for (const hostile of ['BAD%1', 'BAD;1', 'BAD\\x', 'BAD#1']) {
        const { rc, body, stderr } = renderUnit(target, { UNIT_EXTRA_ENV: `GOOD=1 ${hostile}` })
        expect(rc, `render accepted UNIT_EXTRA_ENV=${hostile}`).not.toBe('0')
        expect(body).not.toContain('[Service]')
        expect(stderr, `no warning for ${hostile}`).toContain('UNIT_EXTRA_ENV entry')
        // The valid pair is NOT rendered on its own: a partial unit is worse
        // than none, because the caller installs what it got.
        expect(body).not.toContain('Environment=GOOD=1')
      }
    })

    test(`${target.label}: a newline in UNIT_EXTRA_ENV REFUSES the render, names the entry and prints no unit`, () => {
      // #1112 pinned this case as safe-but-unrefused, on purpose: the loop was
      // `for pair in ${UNIT_EXTRA_ENV:-}`, so IFS ate the line break BEFORE the
      // guard ran, no pair ever contained one, and the blob rendered as four
      // inert `Environment=` lines. That was SAFE (an Environment= value is an
      // assignment, never a directive) and UNREFUSED, and the second half is what
      // #1117 fixed by splitting on a space by hand.
      //
      // So the security property this test originally asserted is now the STRONGEST
      // form available: not "nothing escaped the directive" but "nothing was
      // printed at all", because the refusal happens before the body is emitted.
      const { rc, body, stderr } = renderUnit(target, { UNIT_EXTRA_ENV: 'GOOD=1\nExecStartPre=/bin/rm -rf /' })
      expect(rc, 'render accepted a multi-line UNIT_EXTRA_ENV').not.toBe('0')
      expect(body, 'a partial unit was printed before the refusal').not.toContain('[Service]')
      expect(body, 'a forged ExecStartPre= line appeared in the unit').not.toMatch(/^ExecStartPre=/m)
      // The valid pair is NOT rendered either, and that is the property the old
      // behaviour got wrong: it printed what it could and dropped the rest, so the
      // caller installed a unit missing the variable an operator believed was
      // there. No Environment= line at all is the only honest outcome here.
      expect(body, 'a pair was rendered from a refused blob').not.toContain('Environment=')
      expect(stderr).toContain('UNIT_EXTRA_ENV entry')
      expect(stderr).toMatch(/line break/)
    })

    test(`${target.label}: a TAB between two pairs is refused as a CONTROL CHARACTER, not a line break`, () => {
      // The direct counterpart of the case above, and it pins the split itself.
      // A TAB used to be a SEPARATOR too, so `GOOD=1<TAB>BAD=2` became two
      // perfectly valid pairs and the render was accepted rc=0. The split is on a
      // space now, so the TAB stays INSIDE the pair and the guard names the
      // defect it actually is. Asserting the message is what separates the two
      // classes: a split that reached the line-break arm some other way would
      // fail here instead of passing as a near miss.
      const { rc, body, stderr } = renderUnit(target, { UNIT_EXTRA_ENV: 'GOOD=1\tBAD=2' })
      expect(rc, 'render accepted a TAB-separated UNIT_EXTRA_ENV').not.toBe('0')
      expect(body).not.toContain('[Service]')
      expect(stderr).toContain('UNIT_EXTRA_ENV entry')
      expect(stderr).toMatch(/control character/)
      expect(stderr, 'a TAB is not a line break; the wrong defect was named').not.toMatch(/line break/)
    })

    test(`${target.label}: a blob of several VALID pairs still renders, one Environment= line each`, () => {
      // What keeps every refusal above honest: a guard that refused all blobs
      // would pass all of them. Runs of spaces and leading/trailing ones are here
      // too — a space separates, a run of them adds no empty pair, so no bare
      // `Environment=` line is ever emitted.
      for (const blob of ['A=1 B=2 C=3', 'A=1  B=2', ' A=1 B=2 ']) {
        const { rc, body, stderr } = renderUnit(target, { UNIT_EXTRA_ENV: blob })
        expect(rc, `${JSON.stringify(blob)} was refused: ${stderr.trim()}`).toBe('0')
        for (const pair of blob.split(' ').filter(Boolean)) {
          expect(body, `${JSON.stringify(blob)} lost ${pair}`).toContain(`Environment=${pair}`)
        }
        expect(
          body.split('\n').filter((l) => l === 'Environment='),
          `${JSON.stringify(blob)} rendered an empty pair`,
        ).toEqual([])
      }
    })

    test(`${target.label}: FOO=* does not pathname-expand against the render's working directory`, () => {
      // The old unquoted expansion globbed as well as split, so
      // UNIT_EXTRA_ENV="FOO=*" rendered as whichever files in the CWD matched —
      // the same app.env producing a different unit depending on the directory
      // install.sh happened to run in. Parameter expansion does not glob.
      //
      // `files` is what makes this non-vacuous, and the seeded name has to match
      // the WHOLE pattern: the glob is `FOO=*`, not `*`, so only a file whose name
      // starts with `FOO=` can ever be picked up. In a directory holding exactly
      // that, the old code renders `Environment=FOO=leaked.txt` and the last
      // assertion fails; in a directory holding unrelated files it would leave
      // `FOO=*` unexpanded and this test would pass for the wrong reason. A glob
      // is not a defect, so the render must still SUCCEED — first assertion.
      const { rc, body } = renderUnit(target, { UNIT_EXTRA_ENV: 'FOO=*' }, { files: ['FOO=leaked.txt'] })
      expect(rc, 'a glob is not a defect and must not be refused').toBe('0')
      expect(body).toContain('Environment=FOO=*')
      expect(body, 'the glob was expanded against the working directory').not.toContain('leaked')
    })

    // ── quotes: finding #3 ──
    // Filed by #1112 as "unit_value_defect does not refuse a double quote in a
    // UNIT_EXTRA_ENV pair (FOO=ba\"r renders rc=0) although it refuses a single
    // quote". It did not reproduce, and the reason is a property of the PROBE, not
    // of the guard, so both halves are pinned here.

    test(`${target.label}: unit_value_defect refuses BOTH quotes, measured as an ARGVUMENT`, () => {
      // common.sh matches *'"'*|*"'"* in one arm and has done so since the guard
      // was written. The rc=0 in the finding came from writing the value raw into
      // a script: `UNIT_EXTRA_ENV=FOO=ba"r` is a bash syntax error, so the
      // sourcing shell aborted on that line, the key kept its default empty, and
      // the render succeeded on nothing. The single quote survived that probe only
      // because it happened to be the probe's own delimiter.
      //
      // The value goes in as $1 (see unitValueDefect), so nothing can go wrong
      // between this test and the guard except the guard.
      for (const value of ['FOO=ba"r', "FOO=ba'r", '"', "'", 'A=1 FOO=b"q\'s']) {
        expect(unitValueDefect(value), `${JSON.stringify(value)} was not refused`).toMatch(/quote/)
      }
      // Non-vacuity: a pair with no refused class is silent, so the loop above is
      // not passing because the function always prints something.
      for (const value of ['A=1', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0', 'PATHLIKE=/usr/bin']) {
        expect(unitValueDefect(value), `${JSON.stringify(value)} should be clean`).toBe('')
      }
    })

    test(`${target.label}: a quote in UNIT_EXTRA_ENV is refused end to end, from the line an operator actually writes`, () => {
      // The direct call above proves the guard; this proves the whole path, from
      // the app.env text through sourcing to the render. The value is written the
      // way a `"` survives a double-quoted app.env line at all — backslash-escaped
      // — which is why this is the one place in the file that writes an app.env
      // line itself instead of going through sandboxAppEnvText.
      const { rc, body, stderr } = renderUnit(
        target,
        {},
        { rawAppEnvLines: { UNIT_EXTRA_ENV: 'UNIT_EXTRA_ENV="GOOD=1 FOO=ba\\"r"' } },
      )
      expect(rc, 'render accepted a quoted UNIT_EXTRA_ENV pair').not.toBe('0')
      expect(body, 'a partial unit was printed before the refusal').not.toContain('[Service]')
      expect(body).not.toContain('Environment=GOOD=1')
      expect(stderr).toContain('UNIT_EXTRA_ENV entry')
      expect(stderr).toMatch(/quote/)
    })
  }
})

// ── Gap (d): INSTALL_FLAGS / BUILD_CMD order, and the build timeout ─────────
//
// The pair lives in lib/common.sh so install.sh and update.sh run the identical
// two functions. Order is load-bearing: a build that runs before `bun install`
// has no devDependencies, and the failure names nothing that points at the cause.

describe('deploy/build step — flags, order, and a bounded build', () => {
  for (const target of TARGETS.resolved.filter((t) => readAppEnvValues(t.appEnvPath).DIST === 'source')) {
  declareExercised(TARGETS.resolved.filter((t) => readAppEnvValues(t.appEnvPath).DIST === 'source'))
    const values = readAppEnvValues(target.appEnvPath)
    /**
     * A real source install against the app's own BUILD_CMD, with `bun` stubbed
     * so the trace records the argv without installing a real node_modules.
     *
     * The stub is here for the BUILD, not for the checkout: `git clone` and
     * `git checkout` run for real against a local origin, because the flags and
     * the build sit behind the checkout and a fixture that skipped it would
     * prove nothing about a real install.
     */
    function sourceInstall(opts: { env?: Record<string, string>; buildExit?: number } = {}) {
      const origin = seedGitOrigin(target.label)
      const fx = seedTarget(target, { env: { REPO_URL: origin.url, CHECKOUT_POLICY: 'stable', ...opts.env } })
      const { stubsDir, log } = seedPrivStubs(ensureRoot())
      const trace = join(ROOT, 'bun.log')
      seedBunStub(stubsDir, trace, { buildExit: opts.buildExit })
      seedHealthStub(stubsDir, HEALTHY_BODY)
      const res = runInstall(fx, stubsDir, log, ['--version', origin.tag])
      return { res, trace, stubsDir, log, origin }
    }

    test(`${target.label}: installs dependencies with INSTALL_FLAGS, then runs BUILD_CMD`, () => {
      const { res, trace } = sourceInstall()
      expect(res.status, res.stdout + res.stderr).toBe(0)
      const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
      expect(calls.length, 'bun was never invoked').toBeGreaterThanOrEqual(2)
      // The install comes first, carrying the app's OWN flags verbatim.
      expect(calls[0]).toContain('install')
      for (const flag of values.INSTALL_FLAGS.split(/\s+/).filter(Boolean)) {
        expect(calls[0], `INSTALL_FLAGS value ${flag} did not reach bun install`).toContain(flag)
      }
      // Then the build, as the app's own command, and only after.
      const buildIdx = calls.findIndex((c) => c.startsWith('build '))
      expect(buildIdx, `BUILD_CMD never ran; calls:\n${calls.join('\n')}`).toBeGreaterThan(0)
      // The stub records bun's ARGV, so the recorded line is the app's command
      // without the leading `bun`. Comparing against `bun ${argv}` compares the
      // whole thing the framework was asked to run — which is what BUILD_CMD is.
      expect(`bun ${calls[buildIdx].replace(/^build /, '')}`).toBe(values.BUILD_CMD)
    })

    test(`${target.label}: the checkout is real, so the pair above ran inside it`, () => {
      // Non-vacuity for the test above: the install only reached bun install
      // because a genuine clone and tag checkout happened first. Without this
      // the flags assertion would also hold if source_prepare were broken.
      const { res, trace } = sourceInstall()
      expect(res.status, res.stdout + res.stderr).toBe(0)
      expect(res.stdout).toContain('Cloning')
      const fxInstallDir = join(ROOT, 'opt')
      expect(existsSyncSafe(fxInstallDir)).toBe(true)
      expect(existsSyncSafe(join(fxInstallDir, '.git'))).toBe(true)
      expect(readFileSync(trace, 'utf8')).toContain('install')
    })

    test(`${target.label}: a failing build aborts the install and nothing is installed`, () => {
      const { res, log } = sourceInstall({ buildExit: 1 })
      expect(res.status).not.toBe(0)
      expect(res.stdout).not.toContain('Done.')
      // It names the command and says nothing was installed, because a failed
      // build IS a missing artefact — the worst case to report as success.
      expect(res.stderr + res.stdout).toContain('build failed')
      expect(res.stderr + res.stdout).toMatch(/Nothing was installed/)
      // And no service was started on top of an unbuilt tree.
      expect(privCalls(log).some((c) => c.includes('systemctl') && c.includes('restart'))).toBe(false)
    })

    test(`${target.label}: a build that HANGS is killed at BUILD_TIMEOUT instead of hanging the install`, () => {
      // BUILD_CMD replaced by a sleep, because the point is the TIMEOUT and not
      // the app's own build; everything else (INSTALL_FLAGS, the clone, the
      // checkout, the user) is the app's real configuration.
      const started = Date.now()
      const { res } = sourceInstall({ env: { BUILD_CMD: 'sleep 120', BUILD_TIMEOUT: '2' } })
      const elapsed = Date.now() - started
      expect(res.status, res.stdout + res.stderr).not.toBe(0)
      expect(res.stdout).not.toContain('Done.')
      // The bound is the assertion: 120s of sleep, 2s of budget. Without the
      // timeout this run would sit until the suite's own spawn timeout and fail
      // for a completely different reason.
      expect(elapsed, `install ran for ${elapsed}ms, so the build was not bounded`).toBeLessThan(30_000)
      expect(res.stderr + res.stdout).toMatch(/build failed|timed out|124/)
    })
  }
})

// ── Gap (e): per-app binary file lists ──────────────────────────────────────
//
// #1110's measured finding: without the BINARY_* overrides ziptask cannot
// install AT ALL, because the payload check looks for synaptomind's artefacts.

describe('deploy/BINARY_* — per-app payload shape', () => {
  for (const target of TARGETS.resolved.filter((t) => readAppEnvValues(t.appEnvPath).DIST === 'binary')) {
  declareExercised(TARGETS.resolved.filter((t) => readAppEnvValues(t.appEnvPath).DIST === 'binary'))
    const values = readAppEnvValues(target.appEnvPath)

    /**
     * Run the REAL binary_stage_payload against a fixture release directory,
     * with `curl` stubbed to copy the local asset wherever it is asked for.
     *
     * The required-file check is three lines INSIDE that function
     * (common.sh:1500), not a standalone helper — so there is nothing to call
     * directly. An earlier draft sliced the loop out of the source with `sed` and
     * `eval`'d it; that is a copy of the check that can drift from the check, and
     * it read `$entry` (a `local` of the enclosing function) so it failed for a
     * reason that had nothing to do with the app. Calling the real function, with
     * only the DOWNLOAD stubbed, tests the shipped bytes.
     *
     * `appEnvOverride` is where the BINARY_* keys are swapped, which is how the
     * negative control below turns the framework defaults back on.
     */
    function stagePayload(appEnvOverride: Record<string, string> = {}): { ok: boolean; output: string } {
      const dir = mkTempTree('payload-')
      try {
        const release = seedReleaseDirIn(dir, target.label)
        const asset = join(release.dir, release.tag, `${target.label}-${release.tag}-linux-x86_64.tar.gz`)
        const appEnvFile = join(dir, 'app.env')
        writeFileSync(
          appEnvFile,
          sandboxAppEnvText(target.appEnvPath, {
            INSTALL_DIR: join(dir, 'opt'),
            DATA_DIR: join(dir, 'data'),
            RUN_DIR: join(dir, 'run'),
            RELEASES_BASE: `file://${release.dir}`,
            RELEASE_API: '',
            ...appEnvOverride,
          }),
        )
        const stubs = join(dir, 'stubs')
        mkdirSync(stubs, { recursive: true })
        writeFileSync(
          join(stubs, 'curl'),
          ['#!/usr/bin/env bash', 'out=""; prev=""', 'for a in "$@"; do', '  if [ "$prev" = "-o" ]; then out="$a"; fi', '  prev="$a"', 'done', `cp ${q(asset)} "$out"`, 'exit $?'].join('\n'),
        )
        chmodSync(join(stubs, 'curl'), 0o755)
        const script = `
. ${q(LIB)}
. ${q(appEnvFile)}
detect_os; detect_arch
TAG=v9.9.9-test
binary_stage_payload
printf 'STAGED=%s\\n' "\${STAGED_PAYLOAD:-}"
exit 0
`
        const res = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
          timeout: 60_000,
        })
        return { ok: /STAGED=\S/.test(res.stdout), output: `${res.stdout}${res.stderr}` }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test(`${target.label}: the app's own artefact satisfies BINARY_REQUIRED_FILES`, () => {
      // Driven through the real staging function rather than by reading the list:
      // a list the check ignores would pass this assertion and fail the install.
      const res = stagePayload()
      expect(res.ok, res.output).toBe(true)
      // The staged directory is the payload's own top-level dir, which is what
      // the swap and the version check then operate on.
      // The staged directory is the payload's own top-level dir — the shape the
      // published asset has, and what binary_swap_payload() then moves.
      expect(res.output).toContain(`STAGED=`)
      expect(res.output).toContain(`/${target.label}-9.9.9-test-linux-x86_64`)
    })

    test(`${target.label}: without the BINARY_* overrides the same payload is REFUSED (negative control)`, () => {
      // The framework DEFAULTS are synaptomind's own file names. With them in
      // force, ziptask's payload satisfies none of them — #1110 measured exactly
      // this as `release payload is incomplete: missing synaptomind`, which is
      // why the four BINARY_* keys are load-bearing rather than optional.
      const res = stagePayload({
        BINARY_SUPPORTED_PLATFORMS: 'linux-x86_64',
        BINARY_REQUIRED_FILES: 'synaptomind vec0.so lib/libonnxruntime.so.1',
        BINARY_ROLLBACK_FILES: 'synaptomind vec0.so lib/libonnxruntime.so.1',
        BINARY_SWAP_ORDER: 'synaptomind vec0.so lib/libonnxruntime.so.1',
      })
      expect(res.ok, 'a payload with none of the framework default names passed the check').toBe(false)
      expect(res.output).toMatch(/release payload is incomplete: missing/)
      // It names the file it wanted, which is what makes the message actionable.
      expect(res.output).toContain('synaptomind')
    })

    test(`${target.label}: BINARY_SWAP_ORDER lists every rollback file`, () => {
      // The rollback set is what a no-git rollback moves back. A file in
      // ROLLBACK but not in SWAP_ORDER is never replaced, so the "keep a .prev"
      // promise is false for it.
      const swap = values.BINARY_SWAP_ORDER.split(/\s+/).filter(Boolean)
      for (const file of values.BINARY_ROLLBACK_FILES.split(/\s+/).filter(Boolean)) {
        expect(swap, `${file} is a rollback file but is not in BINARY_SWAP_ORDER`).toContain(file)
      }
    })

    test(`${target.label}: the platform is one the app publishes for`, () => {
      expect(values.BINARY_SUPPORTED_PLATFORMS.split(/\s+/)).toContain('linux-x86_64')
    })
  }
})

// ── Gap (f): the corrected update.sh comment ────────────────────────────────
//
// #1108 corrected a comment that claimed render_systemd_unit() has "exactly ONE
// call site" when it has two (install.sh's install_service and update.sh's
// refresh_unit). The count is the invariant: an audit reading "one call site"
// concludes the update path cannot change the unit body and stops looking. So
// the assertion is a COUNT against the code, not a grep for the word "two".

describe('deploy/update.sh — the two-call-site claim is true', () => {
  const UPDATE_SH = join(DEPLOY_DIR, 'update.sh')

  test('render_systemd_unit is called from exactly the two sites the comment names', () => {
    const callers: string[] = []
    for (const script of ['install.sh', 'update.sh', 'updater.sh', 'uninstall.sh']) {
      const lines = readFileSync(join(DEPLOY_DIR, script), 'utf8').split('\n')
      lines.forEach((line, i) => {
        // A real invocation is the command word itself: a comment mentioning it,
        // and the DEFINITION in lib/common.sh, are both excluded.
        if (line.trimStart().startsWith('#')) return
        if (!/(^|[;&|]|\bif[!\s]|\bthen\s)\s*!?\s*render_systemd_unit\b/.test(line)) return
        callers.push(`${script}:${i + 1}:${line.trim().slice(0, 50)}`)
      })
    }
    expect(callers, `call sites found: ${callers.join(' | ')}`).toHaveLength(2)
    expect(callers.some((c) => c.startsWith('install.sh'))).toBe(true)
    expect(callers.some((c) => c.startsWith('update.sh'))).toBe(true)
  })

  test('the comment above refresh_unit states TWO, and does not still claim ONE', () => {
    const src = readFileSync(UPDATE_SH, 'utf8')
    // The DEFINITION, not the first mention: the word appears in several
    // comments above it, and a slice anchored on one of those would read a
    // different paragraph than the one the claim lives in.
    const start = src.search(/^refresh_unit\(\) \{/m)
    expect(start, 'refresh_unit is gone from update.sh').toBeGreaterThan(-1)
    // The comment BLOCK directly above the definition: back to the section
    // header. Anchored on the box-drawing rule these files use for sections,
    // because splitting on "any comment line" cuts the block into single lines
    // and the claim then cannot be read at all.
    const before = src.slice(0, start)
    const sectionAt = before.lastIndexOf('# ── systemd unit')
    expect(sectionAt, 'the systemd-unit section header above refresh_unit is gone').toBeGreaterThan(-1)
    const header = before.slice(sectionAt)
    // The corrected wording, and the absence of the claim that was wrong. The
    // wrong count was harmful in one direction: an audit reading "one call site"
    // concludes the update path cannot change the unit body and stops looking.
    expect(header, 'the paragraph above refresh_unit does not state the count').toMatch(/TWO call sites/)
    expect(header, 'the paragraph above refresh_unit still claims ONE').not.toMatch(/exactly ONE call site/)
    // And it names the two sites, so the claim is falsifiable by a reader rather
    // than only by this test.
    expect(header).toContain('install_service()')
    expect(header).toContain('refresh_unit()')
  })
})

// ── Per-target helpers ──────────────────────────────────────────────────────

function existsSyncSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function sourceTag(): string {
  return 'v9.9.9-test'
}

/**
 * A real local git origin, with a tag and a package.json, so DIST=source does a
 * genuine `git clone` + `checkout` + `bun install` + build.
 *
 * Not a stubbed clone. The gaps under test (INSTALL_FLAGS order, BUILD_CMD, the
 * bounded build) all sit BEHIND the checkout, and a fixture that skipped the
 * clone would let a broken `source_prepare` pass these tests while breaking
 * every real install. `file://` is used rather than a bare path because
 * `git clone --depth=1` refuses a local path on some git versions, and the point
 * here is to be an ordinary origin.
 */
function seedGitOrigin(label: string, opts: { tag?: string; version?: string } = {}): { url: string; tag: string; version: string } {
  const tag = opts.tag ?? 'v9.9.9-test'
  const version = opts.version ?? '9.9.9-test'
  const root = ensureRoot()
  const origin = join(root, 'origin.git')
  const work = join(root, 'origin-work')
  const git = (...args: string[]) => {
    const res = spawnSync('git', args, { encoding: 'utf8', cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@test' } })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
    return res
  }
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: label, version }, null, 2) + '\n')
  writeFileSync(join(work, '.env.example'), `${label.toUpperCase()}_SETTING=\n`)
  git('init', '--quiet', '--initial-branch=main')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'initial')
  git('tag', tag)
  git('clone', '--quiet', '--bare', work, origin)
  return { url: `file://${origin}`, tag, version }
}

/**
 * A bun stub that records its argv and can be told to fail or hang, so the
 * install/build pair can be asserted on without bun's real behaviour (a
 * 400 MB node_modules install) in the way.
 */
function seedBunStub(stubsDir: string, trace: string, opts: { buildExit?: number } = {}) {
  const path = join(stubsDir, 'bun')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `printf 'bun %s\\n' "$*" >> ${q(trace)}`,
      'case "${1:-}" in',
      '  run)',
      `    printf 'build %s\\n' "$*" >> ${q(trace)}`,
      // Only the BUILD can be made to fail. A non-zero `bun install` would abort
      // before the pair under test was ever reached, which is a different
      // failure with the same message.
      ...(opts.buildExit ? [`    exit ${opts.buildExit}`] : []),
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
}
