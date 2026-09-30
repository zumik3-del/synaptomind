import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'synapto-install-fix-'))
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

function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string | undefined>
  // The derivation only applies when these are absent — drop any inherited value.
  delete env.LIB_RAW_URL
  delete env.APP_ENV_URL
  delete env.DEPLOY_RAW_URL
  return {
    ...env,
    PATH: `${STUB_BIN}:${process.env.PATH}`,
    STUB_CURL_LOG: CURL_LOG,
    STUB_CURL_SERVE_COMMON: REAL_COMMON_SH,
    ...extra,
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

/** A stub payload: `synaptomind --version` prints the expected line. */
function stubPayload(version: string): Record<string, string> {
  return {
    [`${APP}`]: `#!/bin/sh\necho "${APP} ${version}"\n`,
    'vec0.so': 'stub vec0\n',
    'lib/libonnxruntime.so.1': 'stub onnxruntime\n',
    'config.json.example': '{ "server": { "port": 3005 } }\n',
    '.env.example': 'SYNAPTOMIND_SECRET=\n',
  }
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
  opts: { releasesBase: string; appEnv?: Record<string, string>; execSudo?: boolean },
): { deployDir: string; stubsDir: string; sudoLog: string } {
  const deployDir = join(root, 'deploy')
  const stubsDir = join(root, 'stubs')
  const sudoLog = join(root, 'privileged.log')
  cpSync(join(import.meta.dir), deployDir, { recursive: true })
  mkdirSync(stubsDir, { recursive: true })
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
        '  touch|chmod|cp|mv|rm|install) ;;',
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
    PORT: '3999',
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
  return { deployDir, stubsDir, sudoLog }
}

/** Run install.sh from the scratch tree. Never passes --no-service implicitly. */
function runBinaryInstall(deployDir: string, stubsDir: string, sudoLog: string, args: string[]) {
  return spawnSync('bash', [join(deployDir, 'install.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubsDir}:${process.env.PATH}`,
      STUB_PRIV_LOG: sudoLog,
      // Keep a stray APP_ENV_URL/LIB_RAW_URL from the outer env out of the way.
      APP_ENV_URL: '',
      LIB_RAW_URL: '',
    },
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
    ROOT = mkdtempSync(join(tmpdir(), 'synapto-bin-'))
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
    const res = spawnSync('bash', [join(deployDir, 'install.sh'), '--no-service'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubsDir}:${process.env.PATH}`,
        STUB_PRIV_LOG: sudoLog,
      },
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
  function stubHealthy(stubsDir: string, version: string): void {
    const realCurl = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
    const p = join(stubsDir, 'curl')
    writeFileSync(
      p,
      [
        '#!/usr/bin/env bash',
        'for a in "$@"; do',
        '  case "$a" in',
        '    */health)',
        `      printf '%s' '{"status":"ok","version":"${version}","checks":{"database":"ok","embedder":"ok"}}'`,
        '      exit 0 ;;',
        '  esac',
        'done',
        `exec ${realCurl} "$@"`,
      ].join('\n'),
    )
    chmodSync(p, 0o755)
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

  test('a symlinked unit is written through, not replaced by a regular file at 777', () => {
    // The `systemctl link` shape. DECIDED (task #1094): follow the link and swap
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
    ROOT = mkdtempSync(join(tmpdir(), 'synapto-real-'))
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
