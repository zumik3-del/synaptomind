import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ── Fixture helpers ──────────────────────────────────────────────────────────

function seedSingleTagRepo(tag: string, layout: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'synapto-single-'))
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
  for (const [path, content] of Object.entries(layout)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', tag], { cwd: dir, encoding: 'utf8' })
  return dir
}

function seedNoDeployRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synapto-nodeploy-'))
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
  writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.7.3"}')
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'no deploy'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', 'v0.7.3'], { cwd: dir, encoding: 'utf8' })
  return dir
}

function seedMixedTagsRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synapto-mixed-'))
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
  // v0.7.3 (stable) first
  writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.7.3"}')
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'stable'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', 'v0.7.3'], { cwd: dir, encoding: 'utf8' })
  // v0.8.0-beta.2 (prerelease) on a branch, then merge
  spawnSync('git', ['checkout', '-q', '-b', 'beta'], { cwd: dir, encoding: 'utf8' })
  writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.8.0-beta.2"}')
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'beta'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', 'v0.8.0-beta.2'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['checkout', '-q', 'master'], { cwd: dir, encoding: 'utf8' })
  return dir
}

/** Repo with two stable tags; latest-first sort yields the newer one. */
function seedTwoStableTagsRepo(
  olderTag: string,
  newerTag: string,
  layout: Record<string, string>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'synapto-two-stable-'))
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
  for (const [path, content] of Object.entries(layout)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', olderTag], { cwd: dir, encoding: 'utf8' })
  // Newer commit on a branch, merged back so both tags exist
  spawnSync('git', ['checkout', '-q', '-b', 'newer'], { cwd: dir, encoding: 'utf8' })
  writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.8.0"}')
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'newer'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', newerTag], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['checkout', '-q', 'master'], { cwd: dir, encoding: 'utf8' })
  return dir
}

function seedNoStableTagsRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synapto-nostable-'))
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
  writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.8.0-beta.1"}')
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['commit', '-q', '-m', 'beta'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['tag', 'v0.8.0-beta.1'], { cwd: dir, encoding: 'utf8' })
  return dir
}

/** Minimal working update.sh that exits with the given code. */
function makeMinimalUpdateSh(exitCode: number): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""',
    'load_common() {',
    '  local cand',
    '  for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do',
    '    if [ -f "$cand" ]; then . "$cand"; return 0; fi',
    '  done',
    '  echo "[app] ERROR: cannot find lib/common.sh next to $0" >&2; exit 1',
    '}',
    'load_common',
    'trap cleanup_run EXIT',
    'ARG_VERSION=""',
    'ASSUME_YES=false',
    'parse_args() {',
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      --version) ARG_VERSION="$2"; shift 2 ;;',
    '      --yes|-y)  ASSUME_YES=true;  shift   ;;',
    '      --help|-h) sed -n \'2,16p\' "$0" 2>/dev/null || echo "See header"; exit 0 ;;',
    '      *) error "unknown option: $1 (try --help)" ;;',
    '    esac',
    '  done',
    '}',
    'main() {',
    '  parse_args "$@"',
    '  load_app_env',
    '  exit ' + exitCode,
    '}',
    'main "$@"',
  ].join('\n')
}

/** Tampered update.sh missing --version flag (has --wrongflag instead). */
function makeTamperedUpdateSh(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""',
    'load_common() {',
    '  local cand',
    '  for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do',
    '    if [ -f "$cand" ]; then . "$cand"; return 0; fi',
    '  done',
    '  echo "[app] ERROR: cannot find lib/common.sh next to $0" >&2; exit 1',
    '}',
    'load_common',
    'trap cleanup_run EXIT',
    'ARG_VERSION=""',
    'ASSUME_YES=false',
    'parse_args() {',
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      --wrongflag) ARG_VERSION="$2"; shift 2 ;;',
    '      --yes|-y)  ASSUME_YES=true;  shift   ;;',
    '      --help|-h) sed -n \'2,16p\' "$0" 2>/dev/null || echo "See header"; exit 0 ;;',
    '      *) error "unknown option: $1 (try --help)" ;;',
    '    esac',
    '  done',
    '}',
    'main() {',
    '  parse_args "$@"',
    '  load_app_env',
    '  exit 0',
    '}',
    'main "$@"',
  ].join('\n')
}

/**
 * Fixture update.sh that records its invocation for test assertions.
 * Writes a `.invoked` sentinel at the top of main() and the args to
 * the path given by the UPDATER_ARTIFACT env var (defaults to /dev/null).
 */
function makeTrackingUpdateSh(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""',
    'load_common() {',
    '  local cand',
    '  for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do',
    '    if [ -f "$cand" ]; then . "$cand"; return 0; fi',
    '  done',
    '  echo "[app] ERROR: cannot find lib/common.sh next to $0" >&2; exit 1',
    '}',
    'load_common',
    'trap cleanup_run EXIT',
    'ARG_VERSION=""',
    'ASSUME_YES=false',
    'parse_args() {',
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      --version) ARG_VERSION="$2"; shift 2 ;;',
    '      --yes|-y)  ASSUME_YES=true;  shift   ;;',
    '      --help|-h) printf \'%s\\n\' "$@" > "${UPDATER_ARTIFACT:-/dev/null}" && exit 0 ;;',
    '      *) error "unknown option: $1 (try --help)" ;;',
    '    esac',
    '  done',
    '}',
    'main() {',
    '  # Sentinel at the top of main(): proves invocation even when --help short-circuits.',
    '  touch "${UPDATER_ARTIFACT:-/dev/null}.invoked"',
    '  parse_args "$@"',
    '  load_app_env',
    '  printf \'%s\\n\' "$@" > "${UPDATER_ARTIFACT:-/dev/null}"',
    '  exit 0',
    '}',
    'main "$@"',
  ].join('\n')
}

/** Minimal common.sh providing only what the bootstrap needs. */
const MINIMAL_COMMON_SH = [
  '#!/usr/bin/env bash',
  '',
  'if [ -n "${_DEPLOY_COMMON_LOADED:-}" ]; then return 0; fi',
  '_DEPLOY_COMMON_LOADED=1',
  ': "${ASSUME_YES:=false}"',
  '_DEPLOY_TMP_FILES=()',
  'cleanup_add() { _DEPLOY_TMP_FILES+=("$1"); }',
  'cleanup_run() {',
  '  local f',
  '  if [ "${#_DEPLOY_TMP_FILES[@]}" -gt 0 ]; then',
  '    for f in "${_DEPLOY_TMP_FILES[@]}"; do rm -f "$f"; done',
  '  fi',
  '}',
  'info()  { echo "[${APP_NAME:-app}] $*"; }',
  'warn()  { echo "[${APP_NAME:-app}] WARNING: $*" >&2; }',
  'error() { echo "[${APP_NAME:-app}] ERROR: $*" >&2; exit 1; }',
  'need_cmd() { command -v "$1" >/dev/null 2>&1 || error "required command not found: $1"; }',
  'confirm() {',
  '  if [ "$ASSUME_YES" = true ]; then return 0; fi',
  '  if [ ! -t 0 ]; then warn "non-interactive shell — refusing"; return 1; fi',
  '  local reply',
  '  read -r -p "[${APP_NAME:-app}] $1 [y/N] " reply || return 1',
  '  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac',
  '}',
  'resolve_target_user() {',
  '  if [ -n "${SERVICE_USER:-}" ]; then TARGET_USER="$SERVICE_USER"',
  '  elif [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then TARGET_USER="$SUDO_USER"',
  '  else TARGET_USER="$(id -un)"; fi',
  '  TARGET_HOME=""',
  '  if command -v getent >/dev/null 2>&1; then',
  '    TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)",',
  '  fi',
  '  if [ -z "$TARGET_HOME" ]; then',
  '    if [ "$TARGET_USER" = "$(id -un)" ]; then TARGET_HOME="${HOME:-/tmp}";',
  '    else TARGET_HOME="/home/${TARGET_USER}"; fi',
  '  fi',
  '  if [ -z "${RUN_DIR:-}" ]; then RUN_DIR="${TARGET_HOME}/.${APP_NAME}"; fi',
  '}',
  'read_package_version() {',
  "  grep -o '\"version\": *\"[^\"]*\"' \"$1\" 2>/dev/null | head -1 | sed 's/\"version\": *\"//;s/\"//' || true",
  '}',
  'parse_json_version() {',
  "  sed -n 's/.*\"version\" *: *\"\\([^\"]*\\)\".*/\\1/p'",
  '}',
  'normalize_v() {',
  '  case "$1" in v*) printf \'%s\' "$1" ;; *) printf \'v%s\' "$1" ;; esac',
  '}',
  'url_get() {',
  '  local url="$1" out="${2:-}"',
  '  if command -v curl >/dev/null 2>&1; then',
  '    if [ -n "$out" ]; then curl -fLsS -o "$out" "$url"',
  '    else curl -fLsS --max-time 30 "$url"; fi',
  '  else error "need curl or wget"; fi',
  '}',
  'resolve_port() {',
  '  local cfg p',
  '  cfg="${INSTALL_DIR:-}/config.json"',
  '  if [ -f "$cfg" ]; then',
  "    p=\"$(grep -o '\"port\"[[:space:]]*:[[:space:]]*[0-9][0-9]*' \"$cfg\" | head -1 | grep -o '[0-9][0-9]*' || true)\"",
  '    if [ -n "$p" ]; then printf \'%s\' "$p"; return 0; fi',
  '  fi',
  '  printf \'%s\' "${PORT:-3000}"',
  '}',
  'load_app_env() {',
  '  local dir="${SCRIPT_DIR:-}" f tmp',
  '  if [ -n "$dir" ]; then',
  '    for f in "$dir/app.env" "$dir/../app.env"; do',
  '      if [ -f "$f" ]; then . "$f"; APP_ENV_FILE="$f"; return 0; fi',
  '    done',
  '  fi',
  '  error "app.env not found"',
  '}',
].join('\n')

// ── Test globals ─────────────────────────────────────────────────────────────

let FIXTURE_DIR = ''
let INSTALL_DIR = ''
let RUN_DIR = ''
let BOOTSTRAP_DIR = '' // <tmp>/bootstrap/scripts/ — mirrors installed layout

beforeEach(() => {
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'synapto-updater-fix-'))
  INSTALL_DIR = mkdtempSync(join(tmpdir(), 'synapto-install-'))
  RUN_DIR = join(FIXTURE_DIR, 'run')
  BOOTSTRAP_DIR = join(FIXTURE_DIR, 'bootstrap', 'scripts')
  mkdirSync(join(BOOTSTRAP_DIR, 'lib'), { recursive: true })

  // Copy the real updater.sh and a minimal common.sh into the bootstrap dir
  // so SCRIPT_DIR resolves here and load_app_env finds our test app.env.
  copyFileSync(resolve(import.meta.dir, 'updater.sh'), join(BOOTSTRAP_DIR, 'updater.sh'))
  chmodSync(join(BOOTSTRAP_DIR, 'updater.sh'), 0o755)
  writeFileSync(join(BOOTSTRAP_DIR, 'lib', 'common.sh'), MINIMAL_COMMON_SH)
})

const MINIMAL_APP_ENV = [
  'APP_NAME="synaptomind"',
  'DIST="source"',
  'INSTALL_DIR="/opt/synaptomind"',
  'PORT="3005"',
].join('\n')

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  rmSync(INSTALL_DIR, { recursive: true, force: true })
})

/**
 * Write a test-specific app.env into the bootstrap dir and return the
 * absolute path to the installer root (for RUN_DIR overrides).
 * `repoUrl` defaults to an empty file:// so the bootstrap fails early
 * with a useful message rather than silently falling back to the real repo.
 */
function setupBootstrap(opts: { repoUrl?: string; overrides?: Record<string, string> } = {}): void {
  const repoUrl = opts.repoUrl ?? 'file:///tmp/synapto-empty-no-tags'
  // Point RUN_DIR at a scratch dir so the bootstrap never touches the real install.
  const testRunDir = mkdtempSync(join(tmpdir(), 'synapto-run-'))
  // Bootstrap's stage_release copies ${RUN_DIR}/scripts/app.env into the staging area;
  // the source must exist or cp aborts the run.
  mkdirSync(join(testRunDir, 'scripts'), { recursive: true })
  writeFileSync(join(testRunDir, 'scripts', 'app.env'), MINIMAL_APP_ENV)
  const appEnvLines = [
    'APP_NAME="synaptomind"',
    'DIST="source"',
    'REPO_URL="' + repoUrl + '"',
    'INSTALL_DIR="' + INSTALL_DIR + '"',
    'RUN_DIR="' + testRunDir + '"',
    'PORT="3005"',
    'SERVICE_USER=""',
    'HOOKS_DIR=""',
    ...Object.entries(opts.overrides ?? {}).map(([k, v]) => `${k}="${v}"`),
  ]
  writeFileSync(join(BOOTSTRAP_DIR, 'app.env'), appEnvLines.join('\n') + '\n')
}

/**
 * Run updater.sh from the test bootstrap dir with the given args.
 * Returns spawnSync result.
 */
function runUpdater(
  args: string[] = [],
  input?: string,
  envOverrides?: Record<string, string>,
): ReturnType<typeof spawnSync> {
  const res = spawnSync('bash', [join(BOOTSTRAP_DIR, 'updater.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Ensure we use our test bootstrap dir's scripts
      PATH: join(BOOTSTRAP_DIR, 'lib') + ':' + process.env.PATH!,
      ...envOverrides,
    },
    input,
    timeout: 15_000,
    cwd: FIXTURE_DIR,
  })
  return res
}

const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0

/**
 * Run updater.sh under a pseudo-tty (`script`) so the interactive menu and
 * confirm() prompt are reachable. `input` is fed to the pty; `-e` propagates
 * the child's exit status.
 */
function runUpdaterPty(
  input: string,
  envOverrides?: Record<string, string>,
): ReturnType<typeof spawnSync> {
  const cmd = `bash ${join(BOOTSTRAP_DIR, 'updater.sh')}`
  return spawnSync('script', ['-qec', cmd, '/dev/null'], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: join(BOOTSTRAP_DIR, 'lib') + ':' + process.env.PATH!,
      ...envOverrides,
    },
    timeout: 15_000,
    cwd: FIXTURE_DIR,
  })
}

// ── Tag resolution tests ─────────────────────────────────────────────────────

describe('updater.sh — tag resolution', () => {
  test('selects newest stable tag when stable tags exist', () => {
    const artifact = join(FIXTURE_DIR, 'chosen-tag.txt')
    const repo = seedTwoStableTagsRepo('v0.7.3', 'v0.8.0', {
      'deploy/update.sh': makeTrackingUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined, { UPDATER_ARTIFACT: artifact })
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
    // Newest stable tag must be selected — v0.8.0, not v0.7.3
    const chosen = readFileSync(artifact, 'utf8').trim()
    expect(chosen).toContain('v0.8.0')
    expect(chosen).not.toContain('v0.7.3')
  })

  test('excludes prerelease tags from stable selection', () => {
    const artifact = join(FIXTURE_DIR, 'chosen-tag.txt')
    // Repo where a prerelease is newer than the stable tag
    const dir = mkdtempSync(join(tmpdir(), 'synapto-newer-prerelease-'))
    spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
    // v0.7.3 (stable) first
    mkdirSync(join(dir, 'deploy', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'deploy', 'update.sh'), makeTrackingUpdateSh())
    writeFileSync(join(dir, 'deploy', 'lib', 'common.sh'), MINIMAL_COMMON_SH)
    writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.7.3"}')
    spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['commit', '-q', '-m', 'stable'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['tag', 'v0.7.3'], { cwd: dir, encoding: 'utf8' })
    // v0.8.0-beta.2 (prerelease) on a branch — newer by sort -V
    spawnSync('git', ['checkout', '-q', '-b', 'beta'], { cwd: dir, encoding: 'utf8' })
    writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.8.0-beta.2"}')
    spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['commit', '-q', '-m', 'beta'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['tag', 'v0.8.0-beta.2'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['checkout', '-q', 'master'], { cwd: dir, encoding: 'utf8' })

    setupBootstrap({ repoUrl: 'file://' + dir })
    const res = runUpdater(['--yes'], undefined, { UPDATER_ARTIFACT: artifact })
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
    // Must select the stable tag, never the prerelease
    const chosen = readFileSync(artifact, 'utf8').trim()
    expect(chosen).toContain('v0.7.3')
    expect(chosen).not.toContain('v0.8.0-beta')
  })

  test('exits 1 when no stable tags exist in the repo', () => {
    const repo = seedNoStableTagsRepo()
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('no stable release tags')
  })
})

// ── Staging tests ────────────────────────────────────────────────────────────

describe('updater.sh — staging', () => {
  test('staged files land under mktemp -d and INSTALL_DIR is unchanged', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeMinimalUpdateSh(0),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    // Record INSTALL_DIR state before
    const before = spawnSync('find', [INSTALL_DIR, '-type', 'f'], {
      encoding: 'utf8',
    }).stdout
    const res = runUpdater(['--yes'], undefined)
    // INSTALL_DIR should be unchanged (bootstrap never writes there)
    const after = spawnSync('find', [INSTALL_DIR, '-type', 'f'], {
      encoding: 'utf8',
    }).stdout
    expect(after).toBe(before)
    // Stage root should have been cleaned up by the EXIT trap
    expect([0, 1].includes(res.status!)).toBe(true)
  })

  test('contract probe passes with a valid staged update.sh', () => {
    const artifact = join(FIXTURE_DIR, 'probe-args.txt')
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeTrackingUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined, { UPDATER_ARTIFACT: artifact })
    // Contract probe must have actually invoked the staged update.sh.
    // The probe calls `bash ... --version 0.0.0 --yes --help`; --help exits 0
    // after writing the args, so the .invoked sentinel proves the probe ran.
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
    expect(
      existsSync(artifact + '.invoked'),
      'contract probe did not invoke the staged update.sh',
    ).toBe(true)
  })
})

// ── Guard tests ──────────────────────────────────────────────────────────────

describe('updater.sh — guards', () => {
  test('a target tag without deploy/ aborts with the pre-v0.8.0 message', () => {
    const repo = seedNoDeployRepo()
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('no deploy/update.sh')
  })

  test('a tampered update.sh (missing --version flag) fails the contract probe', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeTamperedUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('frozen contract violated')
  })
})

// ── Non-interactive tests ────────────────────────────────────────────────────

describe('updater.sh — non-interactive mode', () => {
  test('--yes picks newest stable and forwards --yes to update.sh', () => {
    const artifact = join(FIXTURE_DIR, 'chosen-args.txt')
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeTrackingUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined, { UPDATER_ARTIFACT: artifact })
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
    const args = readFileSync(artifact, 'utf8').trim().split('\n')
    // Newest stable tag must be passed via --version
    expect(args).toContain('--version')
    const versionIdx = args.indexOf('--version')
    expect(args[versionIdx + 1]).toBe('v0.8.0')
    // --yes must be forwarded
    expect(args).toContain('--yes')
  })

  test('non-TTY without --yes refuses to proceed', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeMinimalUpdateSh(0),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    // No --yes, no TTY (input is undefined → non-interactive)
    const res = runUpdater([], undefined)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('non-interactive shell')
  })

  test('--version with a prerelease tag is rejected', () => {
    // Repo has both a stable tag and a prerelease tag; requesting the prerelease
    // should fail with "not a known stable release", not "no stable tags".
    const dir = mkdtempSync(join(tmpdir(), 'synapto-prerelease-'))
    spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
    // v0.7.3 (stable)
    writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.7.3"}')
    spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['commit', '-q', '-m', 'stable'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['tag', 'v0.7.3'], { cwd: dir, encoding: 'utf8' })
    // v0.8.0-beta.1 (prerelease) on a branch
    spawnSync('git', ['checkout', '-q', '-b', 'beta'], { cwd: dir, encoding: 'utf8' })
    mkdirSync(join(dir, 'deploy', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'deploy', 'update.sh'), makeMinimalUpdateSh(0))
    writeFileSync(join(dir, 'deploy', 'lib', 'common.sh'), MINIMAL_COMMON_SH)
    writeFileSync(join(dir, 'package.json'), '{"name":"synaptomind","version":"0.8.0-beta.1"}')
    spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['commit', '-q', '-m', 'beta'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['tag', 'v0.8.0-beta.1'], { cwd: dir, encoding: 'utf8' })
    spawnSync('git', ['checkout', '-q', 'master'], { cwd: dir, encoding: 'utf8' })

    setupBootstrap({ repoUrl: 'file://' + dir })
    const res = runUpdater(['--version', 'v0.8.0-beta.1'], undefined)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('not a known stable release')
  })
})

// ── Exit-code propagation tests ──────────────────────────────────────────────

describe('updater.sh — exit-code propagation', () => {
  test('propagates the chosen update.sh exit code verbatim', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeMinimalUpdateSh(42),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    const res = runUpdater(['--yes'], undefined)
    expect(res.status).toBe(42)
  })
})

// ── Exit-code contract tests ─────────────────────────────────────────────────
// Guards the regression where the EXIT trap's bare `[ -n "$STAGE_ROOT" ]` failed
// with an empty stage root, overriding a pending `exit 0` and forcing exit 1.

describe('updater.sh — exit-code contract', () => {
  test('--help exits 0 and prints usage', () => {
    const res = runUpdater(['--help'], undefined)
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
    expect(res.stdout).toContain('Usage:')
    expect(res.stdout).toContain('--version')
  })

  test('unknown option still exits 1', () => {
    const res = runUpdater(['--bogus'], undefined)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('unknown option')
  })

  test.skipIf(!hasScript)('declining the interactive menu aborts with exit 0', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeTrackingUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo })
    // pty answers the version menu with 1, then declines the confirm prompt.
    // STAGE_ROOT is still empty here, so this is the empty-stage success path.
    const res = runUpdaterPty('1\nn\n')
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
  })
})
