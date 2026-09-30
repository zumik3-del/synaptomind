import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  opts: { releasesBase: string; appEnv?: Record<string, string> },
): { deployDir: string; stubsDir: string; sudoLog: string } {
  const deployDir = join(root, 'deploy')
  const stubsDir = join(root, 'stubs')
  const sudoLog = join(root, 'privileged.log')
  cpSync(join(import.meta.dir), deployDir, { recursive: true })
  mkdirSync(stubsDir, { recursive: true })
  writeFileSync(sudoLog, '')

  // sudo/systemctl stubs: log and exit 0. Nothing privileged is ever executed.
  for (const name of ['sudo', 'systemctl']) {
    const stub = join(stubsDir, name)
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env bash',
        'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"',
        'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
        'printf \'\\n\' >> "$STUB_PRIV_LOG"',
        name === 'systemctl' ? '[ "$1" = "is-system-running" ] && echo running' : ':',
        'exit 0',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)
  }

  const env = {
    APP_NAME: APP,
    DIST: 'binary',
    INSTALL_DIR: join(root, 'opt', APP),
    DATA_DIR: join(root, 'data'),
    RUN_DIR: join(root, 'run'),
    PORT: '3999',
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
