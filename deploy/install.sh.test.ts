import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
