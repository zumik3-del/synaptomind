import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { guardRealStateDir, installCleanup, isolatedEnv, mkTempTree } from './tmp-fixtures'

// Temp-tree ownership: the sweep removes every tree mkTempTree hands out, after
// each test including one that throws. This file's own afterEach hooks are kept
// (they release earlier, and the sweep is `force`), but no tree depends on a
// call site remembering them — see tmp-fixtures.ts.
installCleanup()
// Fingerprint the operator's real ~/.synaptomind for the whole file: this is
// the check that would have caught #1101, which overwrote the production
// app.env while every assertion in this file stayed green.
guardRealStateDir()

// ── Constants ────────────────────────────────────────────────────────────────

const INSTALL_SH = join(import.meta.dir, 'install.sh')
const REAL_COMMON_SH = join(import.meta.dir, 'lib', 'common.sh')
const DEFAULT_BASE = 'https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy'

// Stub curl: records every invocation, and serves a real common.sh when asked
// for a `.../common.sh` URL so load_common() succeeds and the script proceeds
// to fetch app.env. Every other fetch fails (exit 22) — no network is used.
const STUB_CURL = [
  '#!/usr/bin/env bash',
  'url=""; out=""; prev=""',
  'for a in "$@"; do',
  '  case "$a" in *://*) url="$a" ;; esac',
  '  if [ "$prev" = "-o" ]; then out="$a"; fi',
  '  prev="$a"',
  'done',
  // Log only the URL (one per line) so tests can assert exact values.
  'printf \'%s\\n\' "$url" >> "$STUB_CURL_LOG"',
  'case "$url" in',
  '  */common.sh)',
  '    if [ -n "${STUB_CURL_SERVE_COMMON:-}" ] && [ -n "$out" ]; then',
  '      cp "$STUB_CURL_SERVE_COMMON" "$out"; exit 0',
  '    fi',
  '    ;;',
  'esac',
  'exit 22',
].join('\n')

// ── Fixtures ─────────────────────────────────────────────────────────────────

let FIXTURE_DIR = ''
let STUB_BIN = ''
let CURL_LOG = ''

beforeEach(() => {
  FIXTURE_DIR = mkTempTree('synapto-install-fix-')
  STUB_BIN = join(FIXTURE_DIR, 'bin')
  CURL_LOG = join(FIXTURE_DIR, 'curl.log')
  mkdirSync(STUB_BIN, { recursive: true })
  writeFileSync(join(STUB_BIN, 'curl'), STUB_CURL)
  chmodSync(join(STUB_BIN, 'curl'), 0o755)
  writeFileSync(CURL_LOG, '')
})

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

/**
 * The environment for a spawn of install.sh.
 *
 * Built by isolatedEnv(), so RUN_DIR and every other state-derived path are
 * pinned inside FIXTURE_DIR. Before task #1104 this spread `...process.env` with
 * NO RUN_DIR at all, which meant these spawns resolved RUN_DIR through
 * resolve_target_user() → `getent passwd` → the operator's REAL
 * ~/.synaptomind. The piped runs below happen to abort before
 * install_helper_scripts() (the stub curl refuses app.env), and `--help` aborts
 * in parse_args — so nothing was written on those paths by luck of ordering, not
 * by construction. A fixture that survives one reordering of main() would have
 * overwritten the production config.
 */
function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = isolatedEnv(FIXTURE_DIR, extra) as Record<string, string | undefined>
  // The derivation only applies when these are INHERITED values, so the deletes
  // run against the parent environment BEFORE `extra` is merged in — otherwise a
  // test that deliberately sets APP_ENV_URL has its own override deleted and
  // silently asserts on the derived default instead (which is how
  // 'an explicit APP_ENV_URL wins over the derived default' broke when this
  // helper moved to isolatedEnv).
  for (const key of ['LIB_RAW_URL', 'APP_ENV_URL', 'DEPLOY_RAW_URL']) {
    if (!(key in extra)) delete env[key]
  }
  return {
    ...env,
    PATH: `${STUB_BIN}:${process.env.PATH}`,
    STUB_CURL_LOG: CURL_LOG,
    STUB_CURL_SERVE_COMMON: REAL_COMMON_SH,
  } as Record<string, string>
}

function curlCalls(): string[] {
  const raw = readFileSync(CURL_LOG, 'utf8').trim()
  return raw ? raw.split('\n') : []
}

/** Run install.sh through a pipe (`cat install.sh | bash`), like the one-liner. */
function runPiped(extra: Record<string, string> = {}) {
  const res = spawnSync('bash', [], {
    encoding: 'utf8',
    input: readFileSync(INSTALL_SH, 'utf8'),
    env: testEnv(extra),
    cwd: FIXTURE_DIR,
    timeout: 15_000,
  })
  return { res, calls: curlCalls() }
}

/** Run install.sh as a local checkout (`bash deploy/install.sh --help`). */
function runLocal() {
  const res = spawnSync('bash', [INSTALL_SH, '--help'], {
    encoding: 'utf8',
    env: testEnv(),
    cwd: FIXTURE_DIR,
    timeout: 15_000,
  })
  return { res, calls: curlCalls() }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('install.sh — syntax', () => {
  test('passes `bash -n`', () => {
    const res = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
  })
})

describe('install.sh — piped raw-base derivation', () => {
  test('piped run with no env derives the published base for common.sh and app.env', () => {
    const { res, calls } = runPiped()
    // common.sh was served, app.env fetch failed → pre-install abort.
    expect(res.status).toBe(1)
    expect(calls).toEqual([`${DEFAULT_BASE}/lib/common.sh`, `${DEFAULT_BASE}/app.env`])
  })

  test('DEPLOY_RAW_URL relocates the base for both derived URLs', () => {
    const base = 'https://example.test/deploy'
    const { calls } = runPiped({ DEPLOY_RAW_URL: base })
    expect(calls).toEqual([`${base}/lib/common.sh`, `${base}/app.env`])
  })

  test('an explicit LIB_RAW_URL wins over the derived default', () => {
    const custom = 'https://example.test/custom/common.sh'
    const { calls } = runPiped({ LIB_RAW_URL: custom })
    // app.env still comes from the default base (only LIB_RAW_URL was overridden)
    expect(calls).toEqual([custom, `${DEFAULT_BASE}/app.env`])
  })

  test('an explicit APP_ENV_URL wins over the derived default', () => {
    const custom = 'https://example.test/only.env'
    const { calls } = runPiped({ APP_ENV_URL: custom })
    expect(calls).toEqual([`${DEFAULT_BASE}/lib/common.sh`, custom])
  })

  test('local checkout run does not fetch the published raw URLs', () => {
    const { res, calls } = runLocal()
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('install.sh')
    expect(calls).toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  DIST=binary — release tarball install (ADR 0001 §2.9)
//
//  Everything runs in a scratch tree with --no-service, so no systemd call is
//  ever made and nothing outside the fixture directory is written (AGENTS.md §8:
//  a previous "sandboxed" demo restarted the live service five times).
// ════════════════════════════════════════════════════════════════════════════

const APP = 'synaptomind'
const REAL_TARBALL = resolve(import.meta.dir, '..', 'dist', 'synaptomind-v0.8.0-linux-x86_64.tar.gz')

/**
 * A stub payload: `synaptomind --version` prints the expected line.
 *
 * config.json.example mirrors the SHIPPED example (config.json.example:3-7):
 * both listeners, and both at the values the example ships — `server.port` 3005
 * and `mcp.httpPort` 3006. The mcp block is not decoration: without an
 * `httpPort` key the seeded config has nothing for the aligner to rewrite, and
 * any assertion about mcp.httpPort passes VACUOUSLY (the key is simply absent).
 * Widening the fixture is what makes those assertions able to fail at all.
 */
function stubPayload(version: string): Record<string, string> {
  return {
    [`${APP}`]: `#!/bin/sh\necho "${APP} ${version}"\n`,
    'vec0.so': 'stub vec0\n',
    'lib/libonnxruntime.so.1': 'stub onnxruntime\n',
    'config.json.example':
      '{ "server": { "port": 3005, "host": "127.0.0.1" }, "mcp": { "httpPort": 3006 } }\n',
    '.env.example': 'SYNAPTOMIND_SECRET=\n',
  }
}

/** The ports seed_binary_tree's app.env resolves to unless a test overrides them. */
const FIXTURE_PORT = 3999
/** The value the SHIPPED example carries — an unaligned seed leaves it behind. */
const EXAMPLE_HTTP_PORT = 3006

/** The seeded config.json of a binary install, parsed. */
function seededConfig(root: string): { server: { port: number }; mcp: { httpPort: number } } {
  const raw = readFileSync(join(root, 'opt', APP, 'config.json'), 'utf8')
  return JSON.parse(raw)
}

/**
 * Rewrite the install.sh COPY inside a scratch tree so a test can prove its own
 * assertion is load-bearing. Never touches the repo's install.sh: the mutation
 * exists only inside the fixture the current test already cleans up.
 *
 * Throwing when the target text is absent is deliberate. A reformat that moved
 * the line would otherwise leave the mutation a silent no-op and the non-vacuity
 * test would quietly stop testing anything.
 */
function mutateInstallScript(deployDir: string, from: string, to: string): void {
  const path = join(deployDir, 'install.sh')
  const src = readFileSync(path, 'utf8')
  if (!src.includes(from)) {
    throw new Error(`mutation target absent from install.sh: ${JSON.stringify(from)}`)
  }
  writeFileSync(path, src.replace(from, to))
}

/**
 * A systemctl stub that MODELS a unit instead of just recording the argv.
 *
 * WHY THIS EXISTS. The 0.9.0 defect is invisible to a logging stub: `systemctl
 * start` and `systemctl restart` both "succeed" against a stub that exits 0, so
 * a test could only ever assert which WORD was used. The defect is not the word —
 * it is that `start` on an ALREADY ACTIVE unit is a no-op, so the process that
 * goes on serving is the OLD one. Modelling that needs state:
 *
 *   <stateDir>/running  the version the currently-serving process reports. It is
 *                       read from the payload ON DISK at the moment of the
 *                       (re)start, which is what ExecStart does — so replacing
 *                       the binary without re-launching leaves the old string
 *                       here, exactly as the old process kept answering on the
 *                       real 0.9.0 cutover.
 *   <stateDir>/active   the unit exists and is running.
 *   <stateDir>/events   one line per verb, so a test can assert a no-op as an
 *                       OBSERVED event rather than infer it.
 *
 * `is-active` answers the real exit code (3 = inactive), which is the part of
 * the interface a `--no-service`-style caller branches on.
 *
 * The paths are baked in rather than passed through the environment: a stub that
 * silently found no state directory would answer "not running" to everything and
 * every assertion built on it would pass for the wrong reason — the failure mode
 * that produced two vacuous tests in this directory in the two days before
 * task #1103.
 */
function statefulSystemctlStub(opts: { stateDir: string; payload: string }): string {
  const { stateDir, payload } = opts
  const state = (f: string) => JSON.stringify(join(stateDir, f))
  const bin = JSON.stringify(payload)
  return [
    '#!/usr/bin/env bash',
    // The privileged log is still written: the boundary assertions in this file
    // depend on every call being recorded, state or no state.
    'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"',
    'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
    'printf \'\\n\' >> "$STUB_PRIV_LOG"',
    'mkdir -p ' + JSON.stringify(stateDir),
    // What a fresh ExecStart of the on-disk payload would serve. Deliberately
    // NOT the tag install.sh was asked for: this is the payload, which is the
    // whole distinction the cutover turned on.
    'launch() {',
    `  v="$(${bin} --version 2>/dev/null | awk '{print $2}')"`,
    `  printf '%s' "\${v#v}" > ${state('running')}`,
    `  : > ${state('active')}`,
    `  printf '%s launched %s\\n' "\${1}" "\${v#v}" >> ${state('events')}`,
    '}',
    'case "${1:-}" in',
    '  is-system-running) echo running ;;',
    '  is-active) if [ -f ' + state('active') + ' ]; then exit 0; else exit 3; fi ;;',
    // The no-op under test. Real systemd leaves a running unit untouched.
    '  start)',
    '    if [ -f ' + state('active') + ' ]; then',
    `      printf 'start NO-OP already active, still serving %s\\n' "$(cat ${state('running')})" >> ${state('events')}`,
    '    else',
    '      launch start',
    '    fi ;;',
    // The other rejected alternative: a no-op when the unit is NOT running, so a
    // first install never comes up. Modelled so the choice is testable, not just
    // asserted in a comment.
    '  try-restart)',
    '    if [ -f ' + state('active') + ' ]; then launch try-restart;',
    `    else printf 'try-restart NO-OP unit inactive, nothing started\\n' >> ${state('events')}; fi ;;`,
    '  restart) launch restart ;;',
    '  stop)',
    `    rm -f ${state('active')} ${state('running')}`,
    `    printf 'stop\\n' >> ${state('events')}`,
    '    ;;',
    'esac',
    'exit 0',
  ].join('\n')
}

/** The version the process currently serving would report; '' when nothing is. */
function servingVersion(stateDir: string): string {
  const f = join(stateDir, 'running')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

/** One line per systemctl verb the stub handled, in order. */
function unitEvents(stateDir: string): string[] {
  const f = join(stateDir, 'events')
  if (!existsSync(f)) return []
  const raw = readFileSync(f, 'utf8').trim()
  return raw ? raw.split('\n') : []
}

/**
 * Lay out <root>/<tag>/<asset> as a release directory and tar it into a payload
 * with a single top-level directory, mirroring the published asset.
 */
function seedRelease(
  root: string,
  tag: string,
  payload: Record<string, string>,
  opts: { topDir?: string; asset?: string } = {},
): string {
  const version = tag.replace(/^v/, '')
  const topDir = opts.topDir ?? `${APP}-${version}-linux-x86_64`
  const asset = opts.asset ?? `${APP}-${tag}-linux-x86_64.tar.gz`
  const stage = join(root, '.build', topDir)
  for (const [rel, content] of Object.entries(payload)) {
    const full = join(stage, rel)
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  chmodSync(join(stage, APP), 0o755)

  mkdirSync(join(root, tag), { recursive: true })
  const tarball = join(root, tag, asset)
  const res = spawnSync('tar', ['-czf', tarball, '-C', join(root, '.build'), topDir], {
    encoding: 'utf8',
  })
  expect(res.status, res.stderr).toBe(0)
  return tarball
}

/**
 * Copy deploy/ into a scratch tree, replace app.env with a binary-mode one and
 * neutralise every privileged call: PATH stubs for sudo and systemctl that
 * record their argv and do nothing.
 */
function seedBinaryTree(
  root: string,
  opts: {
    releasesBase: string
    appEnv?: Record<string, string>
    execSudo?: boolean
    /**
     * Make the systemctl stub STATEFUL: it models an installed unit's active
     * state and the version of the payload a running process was started from.
     * See stubUnitStateSystemctl — this is what lets a test say "the old
     * process survived" as an OBSERVED fact rather than as a claim about the
     * words on the command line.
     */
    unitState?: boolean
  },
): { deployDir: string; stubsDir: string; sudoLog: string; stateDir: string } {
  const deployDir = join(root, 'deploy')
  const stubsDir = join(root, 'stubs')
  const sudoLog = join(root, 'privileged.log')
  const stateDir = join(root, 'unitstate')
  cpSync(join(import.meta.dir), deployDir, { recursive: true })
  mkdirSync(stubsDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(sudoLog, '')

  // sudo/systemctl stubs: log and exit 0. Nothing privileged is ever executed —
  // the stub is what stands in for sudo, so the REAL sudo is never invoked and
  // no real system file is touched.
  //
  // `execSudo: true` makes the sudo stub EXEC its arguments instead, which a
  // test that asserts on the BYTES of a written unit needs (a logging stub
  // writes nothing at all, so the unit on disk would be an unexercised path).
  // It is opt-in for exactly that reason: it writes, and only ever inside this
  // fixture's own root, which the stub's guard enforces.
  for (const name of ['sudo', 'systemctl']) {
    const stub = join(stubsDir, name)
    const lines = [
      '#!/usr/bin/env bash',
      'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"',
      'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
      'printf \'\\n\' >> "$STUB_PRIV_LOG"',
    ]
    if (name === 'systemctl') {
      if (opts.unitState) {
        writeFileSync(
          stub,
          statefulSystemctlStub({
            stateDir,
            payload: join(root, 'opt', APP, APP),
          }),
        )
        chmodSync(stub, 0o755)
        continue
      }
      lines.push('[ "$1" = "is-system-running" ] && echo running', 'exit 0')
    } else if (opts.execSudo) {
      lines.push(
        // Only paths under this fixture may be touched, and only the write
        // primitives install.sh uses; anything else is refused loudly rather
        // than silently succeeding.
        'for a in "$@"; do',
        // `--` separator or a relative path is an argument, not a target, and
        // constraining it would make the stub deny what it is meant to allow.
        '  case "$a" in',
        '    /*)',
        // Allowed: the fixture root (where the unit lives) and mktemp -d under
        // TMPDIR, which is where install.sh renders the unit before staging it.
        // Anything else is refused — a stub that execs must not be one a stray
        // absolute path can steer into a real system file.
        `      case "$a" in ${root}/*|"${tmpdir()}"/*) ;; *) echo "STUB: refused path $a" >&2; exit 99 ;; esac`,
        '      ;;',
        '  esac',
        'done',
        'case "${1:-}" in',
        // systemctl is allowed so `sudo systemctl …` resolves to THIS fixture\'s
        // stub rather than being refused. install_service/start_and_verify route
        // daemon-reload, enable and start through run_root, so refusing it would
        // make the privileged log indistinguishable from "the stub was never
        // reached" — the very distinction a test that must prove no REAL
        // systemctl ran depends on.
        '  touch|chmod|cp|mv|rm|install|systemctl) ;;',
        '  *) echo "STUB: refused command ${1:-}" >&2; exit 99 ;;',
        'esac',
        'exec "$@"',
      )
    } else {
      lines.push(':', 'exit 0')
    }
    writeFileSync(stub, lines.join('\n'))
    chmodSync(stub, 0o755)
  }

  const env = {
    APP_NAME: APP,
    DIST: 'binary',
    INSTALL_DIR: join(root, 'opt', APP),
    DATA_DIR: join(root, 'data'),
    RUN_DIR: join(root, 'run'),
    PORT: String(FIXTURE_PORT),
    // Nothing serves /health in these tests, and install.sh's start_and_verify
    // polls it for HEALTH_TIMEOUT. A test that gets as far as a SUCCESSFUL unit
    // install reaches that poll, so the budget is 1s instead of the shipped 60s
    // — otherwise the test times out on the wait rather than on an assertion.
    HEALTH_URL: 'http://127.0.0.1:1/health',
    HEALTH_TIMEOUT: '1',
    RELEASES_BASE: opts.releasesBase,
    RELEASE_API: '',
    CHECKOUT_POLICY: 'stable',
    REQUIRES_BUN: 'no',
    SYSTEM_DEP_CMDS: '',
    SERVICE_USER: '',
    SEED_FILES: 'config.json.example:config.json .env.example:.env',
    GENERATE_SECRET_IN: '.env',
    HOOKS_DIR: '',
    ...opts.appEnv,
  }
  // load_app_env() SOURCES this file, so every value needs its own quoting.
  // The two template keys are single-quoted for the documented reason: a
  // double-quoted ${APP_NAME}-${TAG} would be expanded here at source time and
  // render_template() would have nothing left to substitute (ADR §2.8).
  const SINGLE_QUOTED = new Set(['ASSET_PATTERN', 'APP_VERSION_CMD'])
  const defaults = {
    ASSET_PATTERN: '${APP_NAME}-${TAG}-${OS}-${ARCH}.tar.gz',
    APP_VERSION_CMD: '${BIN} --version',
  }
  const merged: Record<string, string> = { ...defaults, ...env }
  writeFileSync(
    join(deployDir, 'app.env'),
    Object.entries(merged)
      .map(([k, v]) => `${k}=${SINGLE_QUOTED.has(k) ? `'${v}'` : `"${v}"`}`)
      .join('\n') + '\n',
  )
  return { deployDir, stubsDir, sudoLog, stateDir }
}

/**
 * Run install.sh from the scratch tree. Never passes --no-service implicitly.
 *
 * `fixtureRoot` is the fixture's own tree, taken from `deployDir`'s parent rather
 * than from a describe-scoped `let ROOT`: two describes in this file each keep
 * their own ROOT, and a module-level read of either one is a wiring bug that
 * only shows up in the other describe. isolatedEnv pins RUN_DIR (and HOOKS_DIR /
 * UNIT_FILE / DATA_DIR) inside it, so this spawn cannot reach the operator's real
 * ~/.synaptomind even though resolve_target_user() would otherwise derive it from
 * `getent passwd` (task #1104). PATH inheritance is kept — the PATH stub is what
 * makes the sudo/systemctl stubs resolve.
 */
function runBinaryInstall(
  deployDir: string,
  stubsDir: string,
  sudoLog: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const fixtureRoot = dirname(deployDir)
  return spawnSync('bash', [join(deployDir, 'install.sh'), ...args], {
    encoding: 'utf8',
    env: isolatedEnv(fixtureRoot, {
      PATH: `${stubsDir}:${process.env.PATH}`,
      STUB_PRIV_LOG: sudoLog,
      // Keep a stray APP_ENV_URL/LIB_RAW_URL from the outer env out of the way.
      APP_ENV_URL: '',
      LIB_RAW_URL: '',
      ...extraEnv,
    }),
    timeout: 60_000,
  })
}

/** Temporary download/staging artefacts that must never survive a run. */
function tempLeftovers(dir: string): string[] {
  return readdirSync(dir).filter(
    (f) => f.startsWith('.stage.') || f === `.${APP}.tar.gz` || /^\.synaptomind\.\d+\.tar\.gz$/.test(f),
  )
}

describe('install.sh — DIST=binary tarball install', () => {
  let ROOT = ''
  let RELEASES = ''

  beforeEach(() => {
    ROOT = mkTempTree('synapto-bin-')
    RELEASES = join(ROOT, 'releases')
    mkdirSync(RELEASES, { recursive: true })
  })

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  test('extracts the payload: executable at the root, vec0.so, lib/libonnxruntime.so.1', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    const installDir = join(ROOT, 'opt', APP)
    expect(res.status, res.stderr + res.stdout).toBe(0)
    expect(existsSync(join(installDir, APP))).toBe(true)
    expect(existsSync(join(installDir, 'vec0.so'))).toBe(true)
    expect(existsSync(join(installDir, 'lib', 'libonnxruntime.so.1'))).toBe(true)
    // The executable bit must survive the extract.
    expect(statSync(join(installDir, APP)).mode & 0o111).not.toBe(0)
    // Seeding resolves against the extracted payload.
    expect(existsSync(join(installDir, 'config.json'))).toBe(true)
    expect(existsSync(join(installDir, '.env'))).toBe(true)
    expect(readFileSync(join(installDir, '.env'), 'utf8')).toMatch(/SYNAPTOMIND_SECRET=\S{8,}/)
  })

  test('a fresh install leaves no tarball or staging dir behind', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stderr + res.stdout).toBe(0)
    // A ~119 MB tarball per install would otherwise leak into INSTALL_DIR.
    expect(tempLeftovers(join(ROOT, 'opt', APP))).toEqual([])
  })

  // ══════════════════════════════════════════════════════════════════════════
  //  F7 — a --force re-install must not rewrite a ~119 MB .prev set of
  //  byte-identical files, and the rollback story must say what that means.
  //
  //  binary_keep_previous() copied vec0.so, lib/libonnxruntime.so.1 and the
  //  executable into <file>.prev on every install, including a --force
  //  re-install of the SAME payload. The copies are byte-identical, so nothing
  //  is gained, while the cost is the full payload written again onto the same
  //  filesystem as the database — and / on this host reached 100% with zero
  //  bytes free during the 0.9.0 review.
  //
  //  A re-install of the same payload therefore keeps the copy it has, and says
  //  so: the .prev then describes THIS version, not an older one, so a rollback
  //  to it is a no-op — a fact the operator has to be told, not left to infer.
  //  ══════════════════════════════════════════════════════════════════════════

  test('a --force re-install of the same payload does not rewrite an identical .prev (F7)', () => {
    // Run 1 is a fresh install (nothing to keep: there is no previous payload).
    // Run 2 is the first one that CAN write a .prev, so the stamp goes after it.
    //
    // execSudo, or this test proves nothing: the .prev copy goes through
    // write_file_atomically, which stages and renames via run_root, and the
    // logging sudo stub executes nothing — every run would "pass" by never
    // writing a file at all.
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      execSudo: true,
    })
    const installDir = join(ROOT, 'opt', APP)
    const args = ['--version', 'v0.8.0', '--force', '--no-service']

    expect(runBinaryInstall(deployDir, stubsDir, sudoLog, args).status).toBe(0)
    const second = runBinaryInstall(deployDir, stubsDir, sudoLog, args)
    expect(second.status, second.stderr + second.stdout).toBe(0)

    // Stamp every .prev with a known old mtime. A rewrite updates it; a skipped
    // copy leaves it exactly as it was, which is the whole assertion.
    const prevs = ['vec0.so.prev', 'lib/libonnxruntime.so.1.prev', `${APP}.prev`]
    const STAMP = new Date('2001-02-03T04:05:06Z')
    for (const rel of prevs) {
      expect(existsSync(join(installDir, rel)), `${rel} must exist after the second install`).toBe(true)
      utimesSync(join(installDir, rel), STAMP, STAMP)
    }

    const third = runBinaryInstall(deployDir, stubsDir, sudoLog, args)
    expect(third.status, third.stderr + third.stdout).toBe(0)

    for (const rel of prevs) {
      expect(
        statSync(join(installDir, rel)).mtimeMs,
        `${rel} was rewritten with byte-identical content`,
      ).toBe(STAMP.getTime())
    }
    // The story is told, not left to be inferred: the kept copy describes THIS
    // version, so rolling back to it restores this version.
    expect(third.stdout).toContain('byte-identical')
    expect(third.stdout).toMatch(/same version|this version/i)
  }, 60_000)

  test('a --force re-install of a CHANGED payload still refreshes every .prev (F7)', () => {
    // The other direction, and the one that must not regress: skipping must be
    // decided by CONTENT, never by "a .prev already exists". Three payloads in a
    // row, each re-published under the same tag, so run 4 sees a .prev that
    // differs from the installed file and has to be replaced.
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      // The .prev write runs through the shared atomic writer, so the sudo stub
      // has to execute for it (see the test above).
      execSudo: true,
    })
    const installDir = join(ROOT, 'opt', APP)
    const args = ['--version', 'v0.8.0', '--force', '--no-service']
    const republish = (vec: string, onnx: string) => {
      rmSync(join(RELEASES, 'v0.8.0'), { recursive: true, force: true })
      seedRelease(RELEASES, 'v0.8.0', {
        ...stubPayload('v0.8.0'),
        'vec0.so': vec,
        'lib/libonnxruntime.so.1': onnx,
      })
    }

    // 1) stub, 2) stub again (the .prev is created, byte-identical to installed)
    expect(runBinaryInstall(deployDir, stubsDir, sudoLog, args).status).toBe(0)
    expect(runBinaryInstall(deployDir, stubsDir, sudoLog, args).status).toBe(0)
    expect(readFileSync(join(installDir, 'vec0.so.prev'), 'utf8')).toBe('stub vec0\n')

    // 3) a rebuilt artifact. The rollback point is the state from BEFORE this
    //    run, so .prev legitimately still holds the stub bytes here — the copy
    //    would be identical, which is exactly the case F7 stops paying for.
    republish('rebuilt vec0\n', 'rebuilt onnxruntime\n')
    const third = runBinaryInstall(deployDir, stubsDir, sudoLog, args)
    expect(third.status, third.stderr + third.stdout).toBe(0)
    expect(readFileSync(join(installDir, 'vec0.so'), 'utf8')).toBe('rebuilt vec0\n')
    expect(readFileSync(join(installDir, 'vec0.so.prev'), 'utf8')).toBe('stub vec0\n')

    // 4) a second rebuild. Now the installed file and .prev DIFFER, so the skip
    //    must not apply: rolling back has to restore "rebuilt", not the stub.
    //    This is the assertion that fails if the skip is ever decided by
    //    "a .prev already exists" instead of by content.
    republish('rebuilt2 vec0\n', 'rebuilt2 onnxruntime\n')
    const fourth = runBinaryInstall(deployDir, stubsDir, sudoLog, args)
    expect(fourth.status, fourth.stderr + fourth.stdout).toBe(0)
    expect(readFileSync(join(installDir, 'vec0.so'), 'utf8')).toBe('rebuilt2 vec0\n')
    expect(readFileSync(join(installDir, 'vec0.so.prev'), 'utf8')).toBe('rebuilt vec0\n')
    expect(readFileSync(join(installDir, 'lib/libonnxruntime.so.1.prev'), 'utf8')).toBe(
      'rebuilt onnxruntime\n',
    )
  }, 60_000)

  // ══════════════════════════════════════════════════════════════════════════
  //  F5 — a bare version leaked into stdout.
  //
  //  binary_install_payload() ended with `printf '%s' "$got"`, and BOTH callers
  //  invoke it uncaptured (install.sh: install_binary; update.sh: update_binary),
  //  so the version reached the operator's terminal as an unlabelled fragment
  //  glued to whatever line came next — "0.8.2[synaptomind] Running post-update
  //  hook…". It is now INSTALLED_VERSION, like RESOLVED_TAG and STAGED_PAYLOAD:
  // a variable, because a command substitution would run the swap in a subshell
  //  where cleanup_add could not reach the caller's EXIT trap, and because no
  //  caller could have used the printed value anyway.
  // ══════════════════════════════════════════════════════════════════════════

  test('no bare version is written to stdout (F5)', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stderr + res.stdout).toBe(0)

    // Every stdout line belongs to the [app]-prefixed log. The leak was a line
    // with no prefix at all, so assert on the shape of the whole stream rather
    // than on a substring a future log line could contain.
    for (const line of res.stdout.split('\n')) {
      if (line.trim() === '') continue
      expect(line, `unprefixed stdout line: ${JSON.stringify(line)}`).toMatch(
        /^\[synaptomind\]|^\[app\]|^===|^  [A-Za-z]|^$/,
      )
    }
    expect(res.stdout).not.toMatch(/^0\.8\.2/)
    // The version is still reported — as a labelled line.
    expect(res.stdout).toContain('Installed')
    expect(res.stdout).toContain('0.8.0')
  })

  test('a payload missing lib/libonnxruntime.so.1 aborts by name, with nothing swapped', () => {
    const payload = stubPayload('v0.8.0')
    delete payload['lib/libonnxruntime.so.1']
    seedRelease(RELEASES, 'v0.8.0', payload)
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('lib/libonnxruntime.so.1')
    // Nothing may be touched: a unit pointing at a half-installed payload dies
    // on ERR_DLOPEN_FAILED at start.
    const installDir = join(ROOT, 'opt', APP)
    expect(existsSync(join(installDir, APP))).toBe(false)
    expect(existsSync(join(installDir, 'vec0.so'))).toBe(false)
  })

  test('a payload whose binary reports the wrong version aborts, with nothing swapped', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.7.1'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('version check')
    expect(existsSync(join(ROOT, 'opt', APP, APP))).toBe(false)
  })

  test('an archive with two top-level directories is refused, with nothing swapped', () => {
    // Build the bad archive directly: a well-formed payload plus a second
    // top-level directory, which is what a malformed release upload looks like.
    const build = join(ROOT, 'build')
    for (const top of [`${APP}-0.8.0-linux-x86_64`, 'spill']) {
      mkdirSync(join(build, top), { recursive: true })
      if (top.startsWith(APP)) {
        for (const [rel, content] of Object.entries(stubPayload('v0.8.0'))) {
          const full = join(build, top, rel)
          mkdirSync(resolve(full, '..'), { recursive: true })
          writeFileSync(full, content)
        }
        chmodSync(join(build, top, APP), 0o755)
      } else {
        writeFileSync(join(build, top, 'stray'), 'x')
      }
    }
    mkdirSync(join(RELEASES, 'v0.8.0'), { recursive: true })
    const res = spawnSync(
      'tar',
      [
        '-czf',
        join(RELEASES, 'v0.8.0', `${APP}-v0.8.0-linux-x86_64.tar.gz`),
        '-C',
        build,
        `${APP}-0.8.0-linux-x86_64`,
        'spill',
      ],
      { encoding: 'utf8' },
    )
    expect(res.status, res.stderr).toBe(0)

    const tree = seedBinaryTree(ROOT, { releasesBase: `file://${RELEASES}` })
    const res2 = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res2.status).toBe(1)
    expect(res2.stderr).toContain('exactly one top-level directory')
    // The point of staging: a malformed archive must not spill into INSTALL_DIR.
    expect(existsSync(join(ROOT, 'opt', APP, APP))).toBe(false)
    expect(existsSync(join(ROOT, 'opt', APP, 'spill'))).toBe(false)
  })

  test('a platform with no published asset fails by name, not with a 404', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })
    // detect_os/detect_arch read `uname`; stubbing it puts the installer on an
    // arm64 host, which v1 has no asset for (ADR §2.7).
    const unameStub = join(stubsDir, 'uname')
    writeFileSync(
      unameStub,
      ['#!/usr/bin/env bash', 'case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; *) echo Linux ;; esac'].join('\n'),
    )
    chmodSync(unameStub, 0o755)

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    // Must be the named preflight error, not a 404 from url_get a few lines later.
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('no release asset for linux-arm64')
    expect(res.stderr).toContain('supported: linux-x86_64')
    expect(res.stderr).not.toContain('download failed')
  })

  test('a branch CHECKOUT_POLICY is rejected in binary mode', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { CHECKOUT_POLICY: 'dev' },
    })
    // --version short-circuits resolution, so resolution must be exercised.
    // isolatedEnv, not a bare `...process.env`: this is one of the two spawn
    // sites in this file that never went through testEnv(), and it is exactly
    // the shape that let #1101 write to the operator's real app.env. The root
    // is derived from deployDir so this stays correct in whichever describe runs.
    const res = spawnSync('bash', [join(deployDir, 'install.sh'), '--no-service'], {
      encoding: 'utf8',
      env: isolatedEnv(dirname(deployDir), {
        PATH: `${stubsDir}:${process.env.PATH}`,
        STUB_PRIV_LOG: sudoLog,
      }),
      timeout: 60_000,
    })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('requires DIST=source')
  })

  test('--no-service never reaches sudo or systemctl', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })
    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stderr + res.stdout).toBe(0)
    expect(readFileSync(sudoLog, 'utf8')).toBe('')
  })

  // ── the unit-write failure path ───────────────────────────────────────────
  // install_service() warns and returns 0 when the unit cannot be written, so
  // install.sh still reports success. That is defensible for a FRESH install —
  // there is no service to misreport and the summary says "Service: skipped" —
  // but the same path on a re-install over an existing unit leaves that stale
  // unit in place, and the next boot then starts the new payload without
  // Environment=LD_LIBRARY_PATH. The characterising assertions below are the
  // ones that make that visible; changing the exit code is install.sh's own
  // call, not this suite's.
  test('a unit that cannot be written: the install still succeeds but claims no service', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const unitFile = join(ROOT, 'unit', `${APP}.service`)
    mkdirSync(join(ROOT, 'unit'), { recursive: true })
    const stale = '# unit from a previous install, without LD_LIBRARY_PATH\n'
    writeFileSync(unitFile, stale)
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
    })
    // sudo that refuses every write primitive (no tty for a password) and does
    // nothing else. Nothing privileged is executed, exactly as in the other
    // tests here. The refusal list names all of them because the unit is now
    // replaced by a staged rename: the first command a run reaches is `touch`.
    writeFileSync(
      join(stubsDir, 'sudo'),
      [
        '#!/usr/bin/env bash',
        'printf \'sudo\' >> "$STUB_PRIV_LOG"',
        'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
        'printf \'\\n\' >> "$STUB_PRIV_LOG"',
        'case " $* " in *" cp "*|*" chmod "*|*" mv "*|*" touch "*) exit 1 ;; esac',
        'exit 0',
      ].join('\n'),
    )
    chmodSync(join(stubsDir, 'sudo'), 0o755)

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, ['--version', 'v0.8.0'])
    expect(res.status, res.stderr + res.stdout).toBe(0)
    // It must NOT claim a service it did not install, and it must name the
    // command the operator needs instead.
    expect(res.stdout).toContain('Service:    skipped')
    expect(res.stdout).toContain('Start:')
    const log = readFileSync(sudoLog, 'utf8')
    expect(log).toContain(dirname(unitFile))
    // No daemon-reload and no enable: the unit was never written, so systemd
    // must not be told the new body is live.
    expect(log).not.toContain('daemon-reload')
    expect(log).not.toContain('enable')
    // The payload is complete — the failure is scoped to the unit.
    const installDir = join(ROOT, 'opt', APP)
    expect(existsSync(join(installDir, 'lib', 'libonnxruntime.so.1'))).toBe(true)
    // The pre-existing unit is left exactly as it was: this is the deferred
    // harm, and it is asserted rather than left to a reader's imagination.
    expect(readFileSync(unitFile, 'utf8')).toBe(stale)
  })

  // ── the cutover path, atomically (task #1094) ────────────────────────────
  // install.sh is what a FRESH install runs, i.e. exactly the 0.9.0 cutover,
  // and it carried `run_root cp -f "$tmp" "$unit" && run_root chmod 644
  // "$unit"` — the identical O_TRUNC-over-the-live-unit pattern and the forced
  // 644 that #1092 called a blocker in update.sh, at an entry point outside that
  // diff. The trigger stopped being hypothetical when / on this host reached 100%
  // with zero bytes free during the 0.9.0 review.
  const HAND_EDITED_SECRETED = [
    '# hand-edited production unit, mode 600, with a secret in it',
    '[Unit]',
    `Description=${APP} — thought-graph engine (v0.7.1)`,
    '',
    '[Service]',
    'Type=simple',
    'Environment=SYNAPTOMIND_API_TOKEN=super-secret-value',
    `ExecStart=${join(ROOT, 'opt', APP)}`,
    'Restart=always',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')

  /**
   * A `cp` that dies after truncating its destination, the way cp(1) does when
   * the write fails with ENOSPC/EIO or the process is killed mid-copy. Every cp
   * aimed at the unit directory dies; every other cp passes through, so the
   * payload install still happens for real. Installed into the fixture's stubs.
   */
  function breakCpForTheUnitDir(stubsDir: string, unitDir: string): void {
    const realCp = spawnSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()
    const p = join(stubsDir, 'cp')
    writeFileSync(
      p,
      [
        '#!/usr/bin/env bash',
        `dst="\${@: -1}"; src="\${@: -2:1}"`,
        `case "$dst" in ${unitDir}/*) ;; *) exec ${realCp} "$@" ;; esac`,
        ': > "$dst"                     # cp(1) opens the destination O_TRUNC...',
        'head -c 24 "$src" > "$dst"     # ...and only part of the payload lands',
        'echo "cp: error writing $dst: No space left on device" >&2',
        'exit 1',
      ].join('\n'),
    )
    chmodSync(p, 0o755)
  }

  /** Staging files left in the unit directory (a name systemd never loads). */
  function stagedLeftovers(unitFile: string): string[] {
    return readdirSync(dirname(unitFile)).filter((f) => f.includes('.new.'))
  }

  /**
   * A /health that answers, so a test which gets as far as a SUCCESSFUL unit
   * install also gets past start_and_verify (a failed health check makes
   * install.sh exit 1 on its own account, which would mask the assertion this
   * test is about). Nothing is started: the stub answers the one URL and lets
   * every other invocation reach the real curl, so the file:// release
   * download still happens for real.
   */
  function stubHealth(stubsDir: string, body: string, log?: string): void {
    const realCurl = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
    const p = join(stubsDir, 'curl')
    const lines = ['#!/usr/bin/env bash', 'for a in "$@"; do', '  case "$a" in', '    */health)']
    // Record what was served BEFORE answering. A stub that cannot record is
    // worse than no stub: an assertion that "the health check was consulted"
    // then holds vacuously, because a stub that was never reached and one that
    // was reached but wrote nothing are indistinguishable (a harness that could
    // not record was found doing exactly that in this directory the day before).
    if (log) {
      lines.push(`      printf '%s %s\\n' "$a" ${JSON.stringify(body)} >> ${JSON.stringify(log)}`)
    }
    // JSON.stringify because the file is a bash program: the body's own double
    // quotes have to be escaped for bash, and its escaping undone on the way out.
    lines.push(`      printf '%s' ${JSON.stringify(body)}`, '      exit 0 ;;', '  esac', 'done')
    lines.push(`exec ${realCurl} "$@"`)
    writeFileSync(p, lines.join('\n'))
    chmodSync(p, 0o755)
  }

  function healthyBody(version: string): string {
    return JSON.stringify({ status: 'ok', version, checks: { database: 'ok', embedder: 'ok' } })
  }

  function stubHealthy(stubsDir: string, version: string): void {
    stubHealth(stubsDir, healthyBody(version))
  }

  /**
   * A /health whose answer is whatever the stateful systemctl stub says is
   * SERVING — so the endpoint and the unit model cannot drift apart, and a test
   * observes the real consequence of a no-op (`/health` keeps answering with the
   * old version) instead of asserting on the word "restart".
   *
   * When nothing is running there is no answer at all: curl exits 7 (couldn't
   * connect), which is what a closed port gives, so `wait_health` sees a silence
   * and reaches its timeout verdict rather than a fabricated body.
   */
  function stubServingHealth(stubsDir: string, stateDir: string, log?: string): void {
    const realCurl = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
    const p = join(stubsDir, 'curl')
    const running = JSON.stringify(join(stateDir, 'running'))
    const lines = [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      '  case "$a" in',
      '    */health)',
      `    if [ ! -f ${running} ]; then`,
      // rc 7 = CURLE_COULDNT_CONNECT, so an unserved port is unserved.
      '      printf \'curl: (7) Failed to connect\\n\' >&2',
      '      exit 7',
      '    fi',
      '    v="$(cat ' + running + ')"',
    ]
    if (log) {
      // Recorded before answering, and it records the SERVED version, so a test
      // can prove which payload the endpoint was asked about and not merely that
      // something polled it.
      lines.push(`    printf '%s %s\\n' "$a" "$v" >> ${JSON.stringify(log)}`)
    }
    lines.push(
      `    printf '{"status":"ok","version":"%s","checks":{"database":"ok","embedder":"ok"}}' "$v"`,
      '    exit 0 ;;',
      '  esac',
      'done',
      `exec ${realCurl} "$@"`,
    )
    writeFileSync(p, lines.join('\n'))
    chmodSync(p, 0o755)
  }

  /**
   * Rewrite the lib/common.sh COPY inside a scratch tree. Same contract as
   * mutateInstallScript, for the shared gate helper: the mutation exists only
   * inside the fixture the current test already cleans up, and an absent target
   * throws rather than turning the proof into a silent no-op.
   */
  function mutateCommonScript(deployDir: string, from: string, to: string): void {
    const path = join(deployDir, 'lib', 'common.sh')
    const src = readFileSync(path, 'utf8')
    if (!src.includes(from)) {
      throw new Error(`mutation target absent from common.sh: ${JSON.stringify(from)}`)
    }
    writeFileSync(path, src.replace(from, to))
  }



  test('a copy that dies partway leaves the existing unit byte-identical', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const unitDir = join(ROOT, 'unit')
    const unitFile = join(unitDir, `${APP}.service`)
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(unitFile, HAND_EDITED_SECRETED)
    chmodSync(unitFile, 0o600)
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
      execSudo: true,
    })
    breakCpForTheUnitDir(stubsDir, unitDir)

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, ['--version', 'v0.8.0'])
    expect(res.status, res.stderr + res.stdout).toBe(0)
    // The counterexample: `cp -f` opened the live unit O_TRUNC and left 24 bytes
    // of it ("[Unit]" / "Description=") while the run reported "cannot write
    // … skipping service installation". The unit is the operator's, byte for byte.
    expect(readFileSync(unitFile, 'utf8')).toBe(HAND_EDITED_SECRETED)
    // Still 600: the old `chmod 644` was reached only after the successful copy,
    // and would have widened a unit carrying Environment= secrets anyway.
    expect(statSync(unitFile).mode & 0o777).toBe(0o600)
    // No litter in the directory systemd scans.
    expect(stagedLeftovers(unitFile)).toEqual([])
    // And the message reports the real on-disk state rather than the intent:
    // the unit is still there, 289 bytes, not the 24-byte stub the write left.
    expect(res.stderr).toContain('on disk now:')
    expect(res.stderr).toContain(`${Buffer.byteLength(HAND_EDITED_SECRETED)} bytes`)
    expect(res.stderr).toContain('cannot write')
    expect(res.stdout).toContain('Service:    skipped')
  })

  test('a successful install keeps the replaced unit as <unit>.bak, at its own mode', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const unitDir = join(ROOT, 'unit')
    const unitFile = join(unitDir, `${APP}.service`)
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(unitFile, HAND_EDITED_SECRETED)
    chmodSync(unitFile, 0o600)
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
      execSudo: true,
    })
    stubHealthy(stubsDir, '0.8.0')

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, ['--version', 'v0.8.0'])
    expect(res.status, res.stderr + res.stdout).toBe(0)
    // The new unit carries the line a binary install exists to deliver...
    const unit = readFileSync(unitFile, 'utf8')
    expect(unit).toContain(`Environment=LD_LIBRARY_PATH=${join(ROOT, 'opt', APP)}/lib`)
    // ...at the OPERATOR's mode, not a forced 644, and the body it replaced is
    // recoverable: a plain re-run cannot fix a bad install, and the pre-update
    // hook does not cover /etc.
    expect(statSync(unitFile).mode & 0o777).toBe(0o600)
    const backup = `${unitFile}.bak`
    expect(readFileSync(backup, 'utf8')).toBe(HAND_EDITED_SECRETED)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(stagedLeftovers(unitFile)).toEqual([])
    expect(readFileSync(sudoLog, 'utf8')).toContain('daemon-reload')
  })

  test('a symlinked unit is written through, not replaced by a regular file at 777', () => {    // The `systemctl link` shape. DECIDED (task #1094): follow the link and swap
    // the file it points at. `mv -f` over a link would replace the link with a
    // regular file — changing the unit's shape, orphaning the file systemd was
    // NOT loading — and `stat -c '%a'` without -L reports the LINK's own mode
    // (777, a symlink always is), landing a world-writable unit systemd warns
    // about. A fresh install's unit is a regular file, so this is about not
    // surprising an operator who linked one.
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const unitDir = join(ROOT, 'unit')
    const unitFile = join(unitDir, `${APP}.service`)
    const real = join(ROOT, 'linked', `${APP}.service`)
    mkdirSync(unitDir, { recursive: true })
    mkdirSync(join(ROOT, 'linked'), { recursive: true })
    writeFileSync(real, HAND_EDITED_SECRETED)
    chmodSync(real, 0o600)
    symlinkSync(real, unitFile)
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
      execSudo: true,
    })
    stubHealthy(stubsDir, '0.8.0')

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, ['--version', 'v0.8.0'])
    expect(res.status, res.stderr + res.stdout).toBe(0)
    expect(lstatSync(unitFile).isSymbolicLink(), 'the link must survive the install').toBe(true)
    expect(readFileSync(real, 'utf8')).toContain(
      `Environment=LD_LIBRARY_PATH=${join(ROOT, 'opt', APP)}/lib`,
    )
    // The target's own mode, never the link's 777.
    expect(statSync(real).mode & 0o777).toBe(0o600)
    // The .bak beside the link is a plain file, also at the unit's mode.
    const backup = `${unitFile}.bak`
    expect(lstatSync(backup).isSymbolicLink()).toBe(false)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    // The operator is told their link was followed, not silently reshaped.
    expect(res.stdout).toContain('is a link; wrote through it to')
  })

  // ── a value systemd would not parse is refused before anything is written ──
  // #1096 F1/F3. The renderer guards the substituted values (a trailing
  // backslash CONTINUES the next directive away — the whole hardening block can
  // go, with `systemd-analyze verify` still reporting success). install.sh is
  // the FRESH-install path, i.e. the 0.9.0 cutover, and it is the one place
  // where the value is read for the first time on a host: nothing is written
  // before the render, so the refusal can be the whole answer.
  test('a value systemd would fold aborts the install, with no unit written', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const unitFile = join(ROOT, 'unit', `${APP}.service`)
    mkdirSync(join(ROOT, 'unit'), { recursive: true })
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
      execSudo: true,
    })
    // DATA_DIR ending in a backslash: `ReadWritePaths=<install> <data>\` swallows
    // the PrivateTmp=true that follows it. Single-quoted, because the file is
    // SOURCED and a backslash inside single quotes is literal — the reachable
    // shape of this value, not a shape the test had to invent.
    const envFile = join(deployDir, 'app.env')
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(/^DATA_DIR=.*$/m, `DATA_DIR='${join(ROOT, 'data')}\\'`),
    )

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, ['--version', 'v0.8.0'])
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
    expect(res.stdout).not.toContain('Done.')
    // The operator is told WHICH value to fix, and what it would have done.
    expect(res.stderr).toContain('DATA_DIR')
    expect(res.stderr).toContain('backslash')
    // Nothing was installed, so nothing is claimed: no unit, no daemon-reload,
    // no enable — and no "Service: installed" in the summary.
    expect(existsSync(unitFile)).toBe(false)
    const log = readFileSync(sudoLog, 'utf8')
    expect(log).not.toContain('daemon-reload')
    expect(log).not.toContain('enable')
    expect(res.stdout).not.toContain('Service:    installed')
  })

  // ══════════════════════════════════════════════════════════════════════════
  //  mcp.httpPort alignment (2526a0b, task #1077)
  //
  //  A binary install seeds config.json from the shipped example, which carries
  //  mcp.httpPort 3006 while the API port is aligned to this install's PORT. The
  //  two listeners then have nothing to do with each other, so on a host that
  //  already owns 3006 the service installs and dies on EADDRINUSE — and the
  //  installer's remedy names the wrong port.
  //
  //  The rule: a FRESH config gets mcp.httpPort = MCP_PORT, and MCP_PORT defaults
  //  to PORT + 1 (production's 3105/3106). An EXISTING config.json is preserved
  //  verbatim, which is what keeps the migration path (config on 3106, API on
  //  3105) safe.
  // ══════════════════════════════════════════════════════════════════════════

  /** The mcp.httpPort alignment line in seed_files(), as it reads in install.sh. */
  const HTTPPORT_ALIGNMENT =
    `      align_config_port "\${INSTALL_DIR}/\${dest}" '"httpPort"' "\$MCP_PORT"`

  /** The MCP_PORT == PORT guard in main(), as it reads in install.sh. */
  const COLLISION_GUARD = `  if [ "\$MCP_PORT" = "\$PORT" ]; then
    error "MCP_PORT (\${MCP_PORT}) must differ from PORT (\${PORT})"
  fi`

  test('an empty MCP_PORT seeds mcp.httpPort = PORT + 1', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })
    // The default, spelled the way app.env spells it: MCP_PORT is absent, so
    // resolve_mcp_port() must derive the value from PORT alone.
    const appEnv = join(deployDir, 'app.env')
    expect(readFileSync(appEnv, 'utf8')).not.toMatch(/^MCP_PORT=.+$/m)

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stderr + res.stdout).toBe(0)

    const cfg = seededConfig(ROOT)
    // server.port was already aligned before 2526a0b; mcp.httpPort is new.
    expect(cfg.server.port).toBe(FIXTURE_PORT)
    expect(cfg.mcp.httpPort).toBe(FIXTURE_PORT + 1)
    // The bug this fixes, asserted negatively: the example's 3006 must not
    // survive, or the seed binds whatever the host happens to own.
    expect(cfg.mcp.httpPort).not.toBe(EXAMPLE_HTTP_PORT)
    // And the two listeners differ by construction, so they cannot collide.
    expect(cfg.mcp.httpPort).not.toBe(cfg.server.port)
  }, 60_000)

  test('an explicit MCP_PORT is used verbatim', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { MCP_PORT: '4321' },
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stderr + res.stdout).toBe(0)

    const cfg = seededConfig(ROOT)
    // Verbatim: not PORT+1, not the example's value, not clamped to PORT.
    expect(cfg.mcp.httpPort).toBe(4321)
    expect(cfg.mcp.httpPort).not.toBe(FIXTURE_PORT + 1)
    expect(cfg.mcp.httpPort).not.toBe(EXAMPLE_HTTP_PORT)
    // The API port is still this install's own — the override moves one listener.
    expect(cfg.server.port).toBe(FIXTURE_PORT)
  }, 60_000)

  test('MCP_PORT == PORT aborts before the payload is fetched', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { MCP_PORT: String(FIXTURE_PORT) },
    })

    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stderr + res.stdout).toBe(1)
    // Both ports are named, so the operator knows which value to change.
    expect(res.stderr).toContain('MCP_PORT')
    expect(res.stderr).toContain('must differ')
    expect(res.stderr).toContain(String(FIXTURE_PORT))
    // "Before the payload is fetched" is asserted by the absence of the fetch:
    // binary_install_payload() is what creates INSTALL_DIR, so its not existing
    // means the download never started. The release WAS available, so this is
    // the guard's ordering and not an unrelated failure.
    expect(existsSync(join(ROOT, 'opt'))).toBe(false)
    expect(res.stdout).not.toContain('Installed')
  }, 60_000)

  test('an EXISTING config.json is never re-seeded: a hand-edited httpPort survives --force', () => {
    // The case that must not regress. 2526a0b's alignment runs ONLY on the
    // seeding path, and seed_files() skips a config.json that already exists —
    // which is what keeps an installed host's own mcp.httpPort (production's
    // deliberate 3106) and the config-on-3106/API-on-3105 migration path safe
    // from a --force re-run that would otherwise stamp PORT+1 over it.
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })
    const args = ['--version', 'v0.8.0', '--force', '--no-service']
    const first = runBinaryInstall(deployDir, stubsDir, sudoLog, args)
    expect(first.status, first.stderr + first.stdout).toBe(0)
    // Run 1 did seed, and aligned — otherwise this test proves nothing.
    expect(seededConfig(ROOT).mcp.httpPort).toBe(FIXTURE_PORT + 1)

    // Hand-edit to the migration layout: API on 3105, MCP left on 3006.
    const configPath = join(ROOT, 'opt', APP, 'config.json')
    const edited = JSON.parse(readFileSync(configPath, 'utf8'))
    edited.server.port = 3105
    edited.mcp.httpPort = 3106
    edited.handEdited = true
    writeFileSync(configPath, `${JSON.stringify(edited, null, 2)}\n`)

    const second = runBinaryInstall(deployDir, stubsDir, sudoLog, args)
    expect(second.status, second.stderr + second.stdout).toBe(0)

    const cfg = seededConfig(ROOT)
    // Verbatim: every hand-edited value, including the ones alignment would touch.
    // Asserted BEFORE the log line below, so a regression fails on the file's
    // content rather than on a message that a future log edit could change.
    expect(cfg.server.port).toBe(3105)
    expect(cfg.mcp.httpPort).toBe(3106)
    expect(cfg.handEdited).toBe(true)
    // Explicitly NOT re-aligned to this install's ports.
    expect(cfg.mcp.httpPort).not.toBe(FIXTURE_PORT + 1)
    expect(cfg.server.port).not.toBe(FIXTURE_PORT)
    // And the operator is told the file was kept, not left to infer it.
    expect(second.stdout).toContain('Preserved existing config.json')
  }, 60_000)

  // ── non-vacuity: each guard above, with the guard removed ──────────────────
  //
  //  Each of these runs the SAME install twice in one test: once against
  //  install.sh as shipped, once against a mutated COPY inside the fixture
  //  (never the repo's file). The pair is the evidence that the assertion above
  //  is load-bearing — that it fails when the behaviour it guards is gone,
  //  rather than passing for an unrelated reason. A green run of the tests
  //  above is not that evidence; this is.

  test('removing the httpPort alignment is detected (non-vacuity)', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    // Two independent scratch trees, one release: real vs mutated.
    const realRoot = join(ROOT, 'real')
    const mutRoot = join(ROOT, 'mut')
    mkdirSync(realRoot, { recursive: true })
    mkdirSync(mutRoot, { recursive: true })
    const real = seedBinaryTree(realRoot, { releasesBase: `file://${RELEASES}` })
    const mut = seedBinaryTree(mutRoot, { releasesBase: `file://${RELEASES}` })
    // The mutation: the mcp alignment line is dropped, keeping the server.port
    // one. This is 2526a0b's predecessor — the state the change fixed.
    mutateInstallScript(mut.deployDir, `${HTTPPORT_ALIGNMENT}\n`, '')

    const args = ['--version', 'v0.8.0', '--no-service']
    expect(runBinaryInstall(real.deployDir, real.stubsDir, real.sudoLog, args).status).toBe(0)
    const mutRes = runBinaryInstall(mut.deployDir, mut.stubsDir, mut.sudoLog, args)
    expect(mutRes.status, mutRes.stderr + mutRes.stdout).toBe(0)

    // Shipped: aligned. Mutated: the example's 3006 survives — so the assertion
    // `httpPort === PORT + 1` in the test above has something to fail on.
    expect(seededConfig(realRoot).mcp.httpPort).toBe(FIXTURE_PORT + 1)
    const mutated = seededConfig(mutRoot)
    expect(mutated.mcp.httpPort).toBe(EXAMPLE_HTTP_PORT)
    // The mutation removes ONE listener's alignment, not both: server.port is
    // still aligned, so the pair isolates httpPort rather than the whole file.
    expect(mutated.server.port).toBe(FIXTURE_PORT)
  }, 90_000)

  test('removing the existing-config guard is detected (non-vacuity)', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const realRoot = join(ROOT, 'real')
    const mutRoot = join(ROOT, 'mut')
    mkdirSync(realRoot, { recursive: true })
    mkdirSync(mutRoot, { recursive: true })
    const real = seedBinaryTree(realRoot, { releasesBase: `file://${RELEASES}` })
    const mut = seedBinaryTree(mutRoot, { releasesBase: `file://${RELEASES}` })
    // The mutation: seed_files()'s skip is removed (the guard that keeps an
    // existing dest), so the copy+align path runs over an operator's hand-edited
    // config on every re-run. `if false` is the shape of a deleted guard.
    mutateInstallScript(
      mut.deployDir,
      `    if [ -e "\${INSTALL_DIR}/\${dest}" ]; then`,
      `    if false; then`,
    )

    const args = ['--version', 'v0.8.0', '--force', '--no-service']
    for (const [root, tree] of [
      [realRoot, real],
      [mutRoot, mut],
    ] as const) {
      expect(runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, args).status).toBe(0)
      const configPath = join(root, 'opt', APP, 'config.json')
      const edited = JSON.parse(readFileSync(configPath, 'utf8'))
      edited.server.port = 3105
      edited.mcp.httpPort = 3106
      writeFileSync(configPath, `${JSON.stringify(edited, null, 2)}\n`)
    }

    // Re-run over the hand-edited config. Real: preserved. Mutated: overwritten.
    expect(runBinaryInstall(real.deployDir, real.stubsDir, real.sudoLog, args).status).toBe(0)
    expect(runBinaryInstall(mut.deployDir, mut.stubsDir, mut.sudoLog, args).status).toBe(0)

    expect(seededConfig(realRoot).mcp.httpPort).toBe(3106)
    // So `httpPort === 3106` in the test above fails on this tree — the
    // assertion is guarded by the skip, not by the fixture being a fresh install.
    const mutated = seededConfig(mutRoot)
    expect(mutated.mcp.httpPort).toBe(FIXTURE_PORT + 1)
    expect(mutated.server.port).toBe(FIXTURE_PORT)
  }, 90_000)

  test('removing the MCP_PORT == PORT guard is detected (non-vacuity)', () => {
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const realRoot = join(ROOT, 'real')
    const mutRoot = join(ROOT, 'mut')
    mkdirSync(realRoot, { recursive: true })
    mkdirSync(mutRoot, { recursive: true })
    const real = seedBinaryTree(realRoot, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { MCP_PORT: String(FIXTURE_PORT) },
    })
    const mut = seedBinaryTree(mutRoot, {
      releasesBase: `file://${RELEASES}`,
      appEnv: { MCP_PORT: String(FIXTURE_PORT) },
    })
    // The mutation: the collision check is removed from main(), so both
    // listeners are seeded with the SAME port and the install proceeds.
    mutateInstallScript(mut.deployDir, `${COLLISION_GUARD}\n`, '')

    const args = ['--version', 'v0.8.0', '--no-service']
    const realRes = runBinaryInstall(real.deployDir, real.stubsDir, real.sudoLog, args)
    const mutRes = runBinaryInstall(mut.deployDir, mut.stubsDir, mut.sudoLog, args)
    // Shipped: aborted, nothing installed. Mutated: installed a config whose two
    // listeners collide — the exact outcome the guard exists to prevent, and
    // the state `status === 1` in the test above is asserted against.
    expect(realRes.status).toBe(1)
    expect(existsSync(join(realRoot, 'opt'))).toBe(false)
    expect(mutRes.status, mutRes.stderr + mutRes.stdout).toBe(0)
    expect(existsSync(join(mutRoot, 'opt'))).toBe(true)
    const mutated = seededConfig(mutRoot)
    expect(mutated.mcp.httpPort).toBe(mutated.server.port)
  }, 90_000)

  //  install.sh's OWN health gate — start_and_verify (task #1087)
  //
  //  Task #1083 covered wait_health's failure path, but every install.sh test
  //  that installs a service stubs a HEALTHY /health, and every test that
  //  doesn't is `--no-service` — so start_and_verify returned at install.sh:495
  //  (or :496, with no unit installed) and the block at 498-501, the variable it
  //  sets and the `error` that reads it at 609-611, had no test at all. An
  //  install whose service came up unhealthy was
  //  untested end to end: nothing proved the run exits non-zero, and nothing
  //  proved it stops short of the success marker.
  //
  //  Reaching it needs a fixture where a unit CAN be written and a start CAN be
  //  issued, and neither may touch the host. This host is the reason that is not
  //  a formality: /etc/systemd/system/synaptomind.service EXISTS here, owned by
  //  root, and the production service runs as the same unprivileged user as this
  //  suite (AGENTS.md §8 — a real `sudo systemctl` is one SIGTERM from taking the
  //  live service down). So the boundary is enforced three ways, and the third
  //  is asserted rather than assumed:
  //    1. UNIT_FILE redirects the unit into the fixture's own root.
  //    2. A sudo stub stands in for sudo on PATH and refuses every absolute path
  //       outside the fixture root and $TMPDIR, so the REAL sudo never runs
  //       (a PATH stub does not cover sudo's own secure PATH — it is not reached
  //       at all, because the stub answers the call first).
  //    3. `sudo systemctl …` execs into THIS fixture's systemctl stub, which
  //       logs and exits 0. The priv log therefore carries two lines per call —
  //       one from the sudo stub, one from the systemctl stub — and the second
  //       is only there if the stub, not systemd, handled it.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The one privileged call every service install makes, as the log records it.
   *
   * `restart`, not `start` (task #1103): `start` on an already-active unit is a
   * no-op, so an install over a live service left the old process serving. The
   * boundary test below asserts this exact call, so it moves with the fix.
   */
  const systemctlStartLine = 'systemctl restart synaptomind'

  /** The lines of the privileged log, one per run_root/systemctl invocation. */
  function privCalls(sudoLog: string): string[] {
    const raw = readFileSync(sudoLog, 'utf8').trim()
    if (!raw) return []
    // Each stub logs its own $0, so a line opens with the stub's PATH. Reduce it
    // to the command name: what is under assertion is WHICH command ran, not
    // where the stub that recorded it happens to live.
    return raw.split('\n').map((l) => l.replace(/^\S*\/(sudo|systemctl)(?=\s|$)/, '$1'))
  }

  /**
   * Every absolute path any privileged call named, as an ARGUMENT — the leading
   * command name is dropped, because that is the stub's own path and asserting
   * on it would say nothing about what the call touched.
   */
  function privPaths(sudoLog: string): string[] {
    return privCalls(sudoLog)
      .flatMap((line) => line.split(' ').slice(1))
      .filter((arg) => arg.startsWith('/'))
  }

  /**
   * wait_health's /health contract check, exactly as it reads in lib/common.sh.
   *
   * The gate the install's own start_and_verify depends on, quoted here so the
   * non-vacuity test below can weaken it and prove the assertion went with it.
   * Spelled one source line per entry, so it can be diffed against common.sh by
   * eye; mutateCommonScript throws if the text is ever absent, so a reformat
   * cannot quietly turn the proof into a no-op.
   */
  const CONTRACT_CHECK = [
    '      if [ -n "$status" ] && [ "$status_ok" = true ] \\',
    '        && { [ "$version_check" != true ] || [ -n "$version" ]; }; then',
  ].join('\n')

  /** The /health samples the stub actually served, in order. */
  function healthSamples(log: string): string[] {
    if (!existsSync(log)) return []
    const raw = readFileSync(log, 'utf8').trim()
    return raw ? raw.split('\n') : []
  }

  /**
   * A binary install that installs a real (fixture-local) unit and polls a
   * /health that answers `body`. The only thing a caller varies is the payload
   * the endpoint reports.
   */
  function healthGateTree(root: string, releases: string, body: string, healthLog: string) {
    seedRelease(releases, 'v0.8.0', stubPayload('v0.8.0'))
    const unitFile = join(root, 'unit', `${APP}.service`)
    mkdirSync(join(root, 'unit'), { recursive: true })
    const tree = seedBinaryTree(root, {
      releasesBase: `file://${releases}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
      // The unit write goes through write_file_atomically → run_root, so the
      // sudo stub has to execute for the service path to be exercised at all.
      execSudo: true,
    })
    stubHealth(tree.stubsDir, body, healthLog)
    return { ...tree, unitFile }
  }

  test('a /health that passes lets the install finish and report Done', () => {
    // The control, and it is not optional. Without it, "exits non-zero" in the
    // test below could be produced by ANY earlier failure in the run — a
    // refused unit write, an unseeded payload — and would still be green. This
    // run is byte-identical in setup and passes, so the non-zero below is the
    // gate and nothing else.
    const tree = healthGateTree(
      ROOT,
      RELEASES,
      healthyBody('0.8.0'),
      join(ROOT, 'health.log'),
    )

    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.8.0',
    ])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    // The gate really ran and really passed: the endpoint was polled, and the
    // version it reported is the one install.sh was expecting.
    expect(healthSamples(join(ROOT, 'health.log'))).toHaveLength(1)
    expect(res.stdout).toContain('Done.')
    expect(res.stderr).not.toContain('did not pass the health check')
    // The service was installed, not skipped — otherwise the gate was skipped
    // with it and this control would prove nothing.
    expect(res.stdout).toContain(`Service:    ${tree.unitFile}`)
    expect(existsSync(tree.unitFile)).toBe(true)
  }, 60_000)

  test('a /health that reports failed: the install exits non-zero and never says Done', () => {
    // The gap. install.sh:498-501 records HEALTH_OK=false; :609-611 turns that
    // into `error`, i.e. exit 1, before the success marker is reached.
    //
    // A body a STATUS-ONLY read would have accepted is used on purpose: it
    // answers, it is well-formed JSON, it even carries the right version, and
    // only the contract (status ∈ {ok,degraded} AND a version) rejects it. The
    // companion non-vacuity test below reverts the gate to a status-only read
    // and shows this same install reporting success.
    const healthLog = join(ROOT, 'health.log')
    const body = JSON.stringify({
      status: 'failed',
      version: '0.8.0',
      checks: { database: 'ok', embedder: 'ok' },
    })
    const tree = healthGateTree(ROOT, RELEASES, body, healthLog)

    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.8.0',
    ])

    // Non-zero, and for the named reason — not some unrelated failure earlier in
    // the run. The healthy control above runs the same tree shape and exits 0.
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
    expect(res.stderr).toContain('installed but the service did not pass the health check')
    // The success marker is the thing the gate withholds.
    expect(res.stdout).not.toContain('Done.')
    // Characterising, because "prints no success summary" is narrower in fact
    // than in the phrasing: print_summary runs at install.sh:608 BEFORE the gate
    // is read at :609, so the "=== … installed ===" block is still emitted. What
    // the gate withholds is the completion marker, not the operator's summary of
    // what got installed. Pinned so the ordering is a stated fact about this
    // script instead of something a reader has to infer — and so moving
    // print_summary after the gate surfaces here as a deliberate diff.
    expect(res.stdout).toContain(`=== ${APP} installed ===`)
    // And the failure is attributed to the CONTRACT, with the reason in the
    // message, rather than a bare timeout an operator cannot act on.
    expect(res.stderr).toContain('not with a synaptomind /health payload')
    // The endpoint was reached: a status-only read needs a non-empty status, so
    // a run that never polled anything would satisfy the mutation too.
    expect(healthSamples(healthLog)).toHaveLength(1)
    expect(healthSamples(healthLog)[0]).toContain(body)
    // The payload is still fully installed — the gate reports an install that did
    // not come up healthy, it does not pretend the install itself was refused.
    expect(existsSync(join(ROOT, 'opt', APP, APP))).toBe(true)
  }, 60_000)

  test('a /health reporting a different version fails the gate by naming both versions', () => {
    // The other arm the contract check exists for, and the one a status-only read
    // also waves through: status ok, a version present — just not the payload
    // this run installed.
    const tree = healthGateTree(
      ROOT,
      RELEASES,
      healthyBody('0.7.9'),
      join(ROOT, 'health.log'),
    )

    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.8.0',
    ])
    expect(res.status, res.stdout + res.stderr).toBe(1)
    expect(res.stderr).toContain('reports version 0.7.9, expected 0.8.0')
    expect(res.stdout).not.toContain('Done.')
  }, 60_000)

  test('reaching the gate writes a unit and issues a start only inside the fixture', () => {
    // The boundary, asserted rather than assumed — this host has a real
    // /etc/systemd/system/synaptomind.service, so "the fixture does not touch
    // it" is a claim that has to be checked, not a comment.
    const tree = healthGateTree(
      ROOT,
      RELEASES,
      healthyBody('0.8.0'),
      join(ROOT, 'health.log'),
    )

    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.8.0',
    ])
    expect(res.status, res.stdout + res.stderr).toBe(0)

    const calls = privCalls(tree.sudoLog)
    // `sudo systemctl start` was issued…
    expect(calls).toContain(`sudo ${systemctlStartLine}`)
    // …and the SECOND line is the systemctl stub's own. It is only reachable by
    // exec'ing the stub, so its presence is the proof that no real systemctl
    // handled the start. A refused call would have produced only the first line.
    expect(calls).toContain(systemctlStartLine)
    // The unit was written, and at the fixture's path: the write path is
    // exercised for real, so this is a sandbox, not a bypass.
    expect(existsSync(tree.unitFile)).toBe(true)
    expect(readFileSync(tree.unitFile, 'utf8')).toContain(
      `Environment=LD_LIBRARY_PATH=${join(ROOT, 'opt', APP)}/lib`,
    )
    // Every path any privileged call named is inside the fixture root, or the
    // mktemp -d render directory install.sh stages the unit through. Nothing
    // else: /etc/systemd/system is the path this assertion exists to exclude,
    // and a stray absolute path is the way that would be reached.
    // mktemp -d renders the unit to /tmp/tmp.XXXXXXXXXX/ before it is staged, so
    // the render directory itself and the file inside it are both legitimate.
    const renderDir = /^\/tmp\/tmp\.[A-Za-z0-9]+(\/|$)/
    for (const p of privPaths(tree.sudoLog)) {
      expect(
        p.startsWith(`${ROOT}/`) || renderDir.test(p),
        `privileged call touched a path outside the fixture: ${p}`,
      ).toBe(true)
    }
    expect(readFileSync(tree.sudoLog, 'utf8')).not.toContain('/etc/systemd')
  }, 60_000)

  test('reverting the gate to a status-only read makes this install report success (non-vacuity)', () => {
    // The proof that the assertions above are load-bearing. A green run of them
    // is not that evidence; this is: with the contract check weakened to "any
    // non-empty status", the SAME install — same payload, same fixture, same
    // `status: failed` body — stops being a failure. So the exit code, the
    // stderr message and the absent `Done.` in the test above are all decided by
    // the gate, and each would be reported as a failure by a reviewer running
    // this tree.
    //
    // Two independent scratch trees against one release, as the other
    // non-vacuity tests here do: real vs mutated.
    const realRoot = join(ROOT, 'real')
    const mutRoot = join(ROOT, 'mut')
    mkdirSync(realRoot, { recursive: true })
    mkdirSync(mutRoot, { recursive: true })
    seedRelease(RELEASES, 'v0.8.0', stubPayload('v0.8.0'))
    const body = JSON.stringify({
      status: 'failed',
      version: '0.8.0',
      checks: { database: 'ok', embedder: 'ok' },
    })
    const real = healthGateTree(realRoot, RELEASES, body, join(realRoot, 'health.log'))
    const mut = healthGateTree(mutRoot, RELEASES, body, join(mutRoot, 'health.log'))

    // The mutation: wait_health's contract check, reduced to a status-only read —
    // a body counts as this app's /health if it carries any `status` field at
    // all, with no value constraint and no `version` requirement. This is the
    // check the comment above the helper calls out as load-bearing ("Without the
    // version arm … anything else on the port passed as 'Service is healthy'").
    //
    // The target is spelled as it reads in common.sh, one source line per array
    // entry, because it is copied from that file: a template literal would have
    // to escape every `$`, and the escapes are what make a mutation target
    // unverifiable by eye against the file it claims to quote.
    mutateCommonScript(mut.deployDir, CONTRACT_CHECK, '      if [ -n "$status" ]; then')

    const args = ['--version', 'v0.8.0']
    const realRes = runBinaryInstall(real.deployDir, real.stubsDir, real.sudoLog, args)
    const mutRes = runBinaryInstall(mut.deployDir, mut.stubsDir, mut.sudoLog, args)

    // Shipped: the gate refuses a `status: failed` payload.
    expect(realRes.status, realRes.stdout + realRes.stderr).toBe(1)
    expect(realRes.stdout).not.toContain('Done.')
    // Mutated: the exact opposite of every assertion in the test above — exit 0,
    // the success marker printed, and no gate error. The version arm is also
    // gone, so the same tree would wave through a stranger on the port; that is
    // the point of the mutation, not a second thing to fix here.
    expect(mutRes.status, mutRes.stdout + mutRes.stderr).toBe(0)
    expect(mutRes.stdout).toContain('Done.')
    expect(mutRes.stderr).not.toContain('did not pass the health check')
    // Both trees polled the same single sample, so the pair differs only in the
    // gate and not in how much of the health window each run saw.
    expect(healthSamples(join(realRoot, 'health.log'))).toHaveLength(1)
    expect(healthSamples(join(mutRoot, 'health.log'))).toHaveLength(1)
  }, 90_000)

  // ══════════════════════════════════════════════════════════════════════════
  //  task #1103 — install.sh --force over an ALREADY RUNNING service
  //
  //  The real 0.9.0 cutover on 2026-10-01: install.sh reported
  //  `Installed /opt/synaptomind/synaptomind (0.9.0)`, rendered the new unit,
  //  and then failed its own health gate with `/health reports version 0.8.0,
  //  expected 0.9.0` — MainPID unchanged, NRestarts=0. start_and_verify issued
  //  `systemctl start`, and `start` on an already-active unit is a no-op, so the
  //  OLD process went on serving while the new payload and unit sat on disk
  //  unused. The gate was RIGHT. The install only took effect once an operator
  //  ran `systemctl restart` by hand.
  //
  //  Why this block needs a STATEFUL systemctl and not the logging stub: `start`
  //  and `restart` both exit 0 against a logging stub, so the old code would
  //  have been indistinguishable from the fix. statefulSystemctlStub models the
  //  one property under test — a no-op `start` leaves the running payload in
  //  place — and stubServingHealth answers /health with the version that payload
  //  reports. So every assertion below is on OBSERVED behaviour: what the
  //  endpoint served, whether the gate passed, and which verb ran.
  // ══════════════════════════════════════════════════════════════════════════

  const RESTART_CALL = '  if run_root systemctl restart "$APP_NAME"; then'

  /**
   * A two-install tree: 0.8.0 first (a fresh install, which brings the unit UP),
   * then 0.9.0 with --force over the service that first install left running —
   * the production sequence. The unit lives inside the fixture root and the
   * systemctl stub stands in for systemd, so nothing privileged and nothing
   * outside the fixture is touched.
   */
  function reinstallTree(root: string, releases: string, opts: { mutate?: (deployDir: string) => void } = {}) {
    seedRelease(releases, 'v0.8.0', stubPayload('v0.8.0'))
    seedRelease(releases, 'v0.9.0', stubPayload('v0.9.0'))
    const unitFile = join(root, 'unit', `${APP}.service`)
    mkdirSync(join(root, 'unit'), { recursive: true })
    const healthLog = join(root, 'health.log')
    const tree = seedBinaryTree(root, {
      releasesBase: `file://${releases}`,
      appEnv: { UNIT_FILE: unitFile, APP_DESC: 'Synaptomind — thought-graph engine' },
      // The unit write goes through run_root, so the sudo stub must execute for
      // the service path to be exercised at all.
      execSudo: true,
      unitState: true,
    })
    stubServingHealth(tree.stubsDir, tree.stateDir, healthLog)
    opts.mutate?.(tree.deployDir)
    return { ...tree, unitFile, healthLog }
  }

  test('a --force re-install over a RUNNING service brings the new payload up', () => {
    const tree = reinstallTree(ROOT, RELEASES)
    const healthLog = tree.healthLog

    // Run 1: the fresh install. The unit is not active yet, so this is also the
    // FIRST-INSTALL case: whatever verb the fix uses has to start it here.
    const first = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, ['--version', 'v0.8.0'])
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(servingVersion(tree.stateDir), 'the first install must have started the unit').toBe('0.8.0')
    // Run 1's own polls saw 0.8.0 — so the samples asserted below can only be 0.9.0
    // if run 2 really did put the new payload on the port.
    const afterFirst = healthSamples(healthLog).length
    expect(afterFirst).toBeGreaterThan(0)
    for (const s of healthSamples(healthLog)) expect(s).toContain(' 0.8.0')

    // Run 2: the payload and the unit are replaced under a unit that is already
    // active. This is where `start` used to no-op.
    const second = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.9.0',
      '--force',
    ])

    // The observable the defect denied: the SERVING payload is the new one.
    expect(servingVersion(tree.stateDir)).toBe('0.9.0')
    // And the endpoint agreed — read from what it actually answered, not from
    // what the payload on disk says. Only run 2's samples, sliced by the count
    // taken above, and EVERY one of them: the first poll is the one that would
    // have caught the old process.
    const all = healthSamples(healthLog)
    expect(all.length, 'run 2 must have polled /health').toBeGreaterThan(afterFirst)
    for (const s of all.slice(afterFirst)) expect(s).toContain(' 0.9.0')
    // Which is why the gate passed and the run reported success — the thing the
    // 0.9.0 cutover could not do.
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('Done.')
    // The unit was replaced, not skipped: a `start`-only fix would pass the
    // assertions above with a STALE unit on disk.
    expect(existsSync(tree.unitFile)).toBe(true)
    expect(privCalls(tree.sudoLog)).toContain(`sudo ${systemctlStartLine}`)
  }, 90_000)

  test('reverting restart to start leaves the OLD payload serving (non-vacuity)', () => {
    // The proof the test above is load-bearing: with the shipped verb reverted to
    // the `systemctl start` of the 0.9.0 cutover — the SAME two-install sequence,
    // same payloads, same fixture — the second run no-ops and reproduces the
    // production failure exactly, gate message included. A green run of the test
    // above is not that evidence; this is.
    const realRoot = join(ROOT, 'real')
    const mutRoot = join(ROOT, 'mut')
    mkdirSync(realRoot, { recursive: true })
    mkdirSync(mutRoot, { recursive: true })
    const real = reinstallTree(realRoot, RELEASES)
    const mut = reinstallTree(mutRoot, RELEASES, {
      // The mutation is the historical code, not a weakened gate: the health
      // check is untouched, so the only variable is the verb that puts the
      // service on the new payload.
      mutate: (deployDir) => mutateInstallScript(deployDir, RESTART_CALL, '  if run_root systemctl start "$APP_NAME"; then'),
    })

    const first = ['--version', 'v0.8.0']
    expect(runBinaryInstall(real.deployDir, real.stubsDir, real.sudoLog, first).status).toBe(0)
    expect(runBinaryInstall(mut.deployDir, mut.stubsDir, mut.sudoLog, first).status).toBe(0)
    // Both trees really did have a RUNNING service before the re-install. Without
    // this the mutated run could "pass" for the wrong reason — by never having
    // been in the state the defect needs.
    expect(servingVersion(real.stateDir)).toBe('0.8.0')
    expect(servingVersion(mut.stateDir)).toBe('0.8.0')

    const second = ['--version', 'v0.9.0', '--force']
    const realRes = runBinaryInstall(real.deployDir, real.stubsDir, real.sudoLog, second)
    const mutRes = runBinaryInstall(mut.deployDir, mut.stubsDir, mut.sudoLog, second)

    // Mutated: the old process survived, and the install failed its own gate with
    // the message the real cutover produced. The payload on disk IS 0.9.0 — this
    // is not a failed download being mistaken for a restart problem.
    expect(servingVersion(mut.stateDir), 'the old process must still be serving').toBe('0.8.0')
    expect(mutRes.status, mutRes.stdout + mutRes.stderr).toBe(1)
    expect(mutRes.stderr).toContain('reports version 0.8.0, expected 0.9.0')
    expect(mutRes.stdout).not.toContain('Done.')
    // The no-op is observed in the stub's own event log, not inferred from the
    // absence of a restart: a stub that recorded nothing would make this vacuous.
    expect(unitEvents(mut.stateDir)).toContain('start NO-OP already active, still serving 0.8.0')
    // And the mutated endpoint kept answering with the OLD version, which is the
    // mechanism the gate caught: every sample of run 2 reports 0.8.0 while the
    // run expected 0.9.0.
    const mutSamples = healthSamples(mut.healthLog)
    expect(mutSamples.length).toBeGreaterThan(0)
    for (const s of mutSamples) expect(s).toContain(' 0.8.0')
    expect(
      readFileSync(join(mutRoot, 'opt', APP, APP), 'utf8'),
      'the payload on disk was replaced anyway',
    ).toContain('synaptomind v0.9.0')

    // Shipped: the opposite on every one of those points.
    expect(servingVersion(real.stateDir)).toBe('0.9.0')
    expect(realRes.status, realRes.stdout + realRes.stderr).toBe(0)
    expect(realRes.stdout).toContain('Done.')
    expect(unitEvents(real.stateDir)).toContain('restart launched 0.9.0')
  }, 120_000)

  test('the FIRST install still comes up: the unit is not active yet', () => {
    // The constraint that rules `try-restart` out. A first install has no running
    // unit, so a verb that no-ops on an inactive unit leaves the service DOWN and
    // the gate timing out on a service that was never asked to start. Asserted
    // against the shipped code, with the state proving the unit came up from
    // nothing.
    const tree = reinstallTree(ROOT, RELEASES)
    expect(existsSync(join(tree.stateDir, 'active')), 'precondition: nothing is active').toBe(false)

    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, ['--version', 'v0.8.0'])

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(res.stdout).toContain('Done.')
    expect(servingVersion(tree.stateDir)).toBe('0.8.0')
    expect(unitEvents(tree.stateDir)).toEqual(['restart launched 0.8.0'])
  }, 60_000)

  test('try-restart would leave a FIRST install down — and is not what ships (non-vacuity)', () => {
    // Why the alternatives lose, demonstrated rather than asserted in a comment.
    // `try-restart` replaces the payload on a running unit just as well as
    // `restart` does, so a test that only covered the re-install could not tell
    // them apart; on a FIRST install it is inert and the service never comes up.
    const tree = reinstallTree(ROOT, RELEASES, {
      mutate: (deployDir) => mutateInstallScript(deployDir, RESTART_CALL, '  if run_root systemctl try-restart "$APP_NAME"; then'),
    })

    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, ['--version', 'v0.8.0'])

    // The payload and the unit are on disk and complete — the ONLY thing missing
    // is a running process, which is the whole point.
    expect(existsSync(join(ROOT, 'opt', APP, APP))).toBe(true)
    expect(existsSync(tree.unitFile)).toBe(true)
    // Nothing was ever launched, so nothing serves and the gate times out.
    expect(servingVersion(tree.stateDir)).toBe('')
    expect(unitEvents(tree.stateDir)).toContain('try-restart NO-OP unit inactive, nothing started')
    expect(res.status, res.stdout + res.stderr).toBe(1)
    expect(res.stderr).toContain('did not pass the health check')
    expect(res.stdout).not.toContain('Done.')
  }, 60_000)

  test('a version mismatch still fails the run loudly after the fix', () => {
    // The gate is not what changed, and this pins that. A /health that answers a
    // version this install did NOT put there must still fail the run, even though
    // the restart succeeded and the summary was printed.
    const tree = healthGateTree(ROOT, RELEASES, healthyBody('0.7.9'), join(ROOT, 'health.log'))
    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, ['--version', 'v0.8.0'])
    expect(res.status, res.stdout + res.stderr).toBe(1)
    expect(res.stderr).toContain('reports version 0.7.9, expected 0.8.0')
    expect(res.stdout).not.toContain('Done.')
    // Characterising, and unchanged by this task: print_summary still runs BEFORE
    // the gate is read (task #1087 pinned it), so the operator sees the restart
    // line, then the === … installed === block, then the failure. Nothing about
    // that ordering moved — pinned here so a future reorder surfaces as a diff.
    expect(res.stdout).toContain(`=== ${APP} installed ===`)
    expect(res.stdout.indexOf(`=== ${APP} installed ===`)).toBeLessThan(
      res.stdout.indexOf('Done.') === -1 ? res.stdout.length : res.stdout.indexOf('Done.'),
    )
  }, 60_000)

  test('--no-service still reaches neither systemctl nor sudo', () => {
    // Re-pinned because the fix added a verb to this path's neighbourhood: the
    // early return has to stay above it, or a --no-service install would restart
    // a service the operator told it not to touch.
    const tree = reinstallTree(ROOT, RELEASES)
    const res = runBinaryInstall(tree.deployDir, tree.stubsDir, tree.sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(readFileSync(tree.sudoLog, 'utf8')).toBe('')
    expect(unitEvents(tree.stateDir)).toEqual([])
    expect(servingVersion(tree.stateDir)).toBe('')
  }, 60_000)
})

// ════════════════════════════════════════════════════════════════════════════
//  The real, 50 MB release artifact produced by scripts/build-tarball.ts.
//  Skipped when dist/ is absent (it is gitignored) so the suite stays green on
//  a fresh clone; the ADR's §3.2 layout assertion lives here.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!existsSync(REAL_TARBALL))('install.sh — the real published tarball', () => {
  // These tests copy and extract the REAL ~50 MB release artifact, twice per
  // run. Bun's default 5 s per-test budget is not enough headroom on a loaded
  // host or a CI runner, which made the suite intermittently red with
  // "this test timed out" instead of a real assertion failure. Each test below
  // therefore sets an explicit budget rather than raising the file default.
  let ROOT = ''
  let RELEASES = ''

  beforeEach(() => {
    ROOT = mkTempTree('synapto-real-')
    RELEASES = join(ROOT, 'releases')
    mkdirSync(join(RELEASES, 'v0.8.0'), { recursive: true })
    cpSync(REAL_TARBALL, join(RELEASES, 'v0.8.0', 'synaptomind-v0.8.0-linux-x86_64.tar.gz'))
  })

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  test('installs the real payload and the binary reports v0.8.0 with no bun', () => {
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })
    const res = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    const installDir = join(ROOT, 'opt', APP)
    expect(res.status, res.stderr + res.stdout).toBe(0)
    for (const rel of [APP, 'vec0.so', 'lib/libonnxruntime.so.1']) {
      expect(existsSync(join(installDir, rel)), rel).toBe(true)
    }
    // The version check in the installer already ran the binary; assert the
    // contract directly under `env -i` so no bun on PATH can answer for it.
    const ver = spawnSync(
      'env',
      ['-i', join(installDir, APP), '--version'],
      { encoding: 'utf8' },
    )
    expect(ver.stdout.trim(), ver.stderr).toBe('synaptomind v0.8.0')
    expect(tempLeftovers(installDir)).toEqual([])
  }, 60_000)

  test('a second run reports "already installed" instead of aborting with --force', () => {
    // Regression: ver_cmp "v0.8.0" "0.8.0" answers "newer", so an up-to-date
    // binary install used to fail with "use --force to override" (ADR §2.6).
    const { deployDir, stubsDir, sudoLog } = seedBinaryTree(ROOT, {
      releasesBase: `file://${RELEASES}`,
    })
    const first = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(first.status, first.stderr + first.stdout).toBe(0)
    const second = runBinaryInstall(deployDir, stubsDir, sudoLog, [
      '--version',
      'v0.8.0',
      '--no-service',
    ])
    expect(second.status, second.stderr + second.stdout).toBe(0)
    expect(second.stdout).toContain('up to date')
    expect(second.stderr).not.toContain('--force')
  }, 60_000)
})
