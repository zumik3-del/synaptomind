import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  lstatSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

// ════════════════════════════════════════════════════════════════════════════
//  DIST=binary — release tarball update (ADR 0001 §2.9) and the unit re-render
//  the conformance audit found missing (audit finding 1: render_systemd_unit
//  had exactly ONE call site, install.sh, so an install updating INTO binary
//  mode never received Environment=LD_LIBRARY_PATH).
//
//  No real sudo and no real systemctl: both are PATH stubs whose sudo variant is
//  a GUARDED passthrough — it refuses to execute unless every path-like argument
//  lives under the fixture root, so the suite cannot touch the live service even
//  by accident (AGENTS.md §8).
// ════════════════════════════════════════════════════════════════════════════

const U_APP = 'synaptomind'

/**
 * Guarded sudo: logs argv, then executes only if every path is under ROOT.
 * `refuse` names commands the stub pretends to be denied for (a sudo that needs
 * a password it cannot get), so a test can fail ONE privileged call — the unit
 * copy — while every other call still runs.
 */
function makeGuardedSudo(
  privLog: string,
  guard: string,
  opts: { refuse?: string[] } = {},
): string {
  const lines = [
    '#!/usr/bin/env bash',
    'printf \'sudo\' >> "$STUB_PRIV_LOG"',
    'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
    'printf \'\\n\' >> "$STUB_PRIV_LOG"',
  ]
  for (const cmd of opts.refuse ?? []) {
    lines.push(
      `case " $* " in *" ${cmd} "*) echo "sudo: ${cmd}: a terminal is required to ask for a password" >&2; exit 1 ;; esac`,
    )
  }
  lines.push(
    // Everything must be inside the fixture root, or refuse loudly.
    'for a in "$@"; do',
    '  case "$a" in /*) case "$a" in ' + guard + ') ;; *) echo "REFUSED: $a" >&2; exit 99 ;; esac ;; esac',
    'done',
    'exec "$@"',
  )
  return lines.join('\n')
}

const SYSTEMCTL_STUB = [
  '#!/usr/bin/env bash',
  'printf \'systemctl\' >> "$STUB_PRIV_LOG"',
  'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
  'printf \'\\n\' >> "$STUB_PRIV_LOG"',
  'case "$1" in',
  '  is-system-running) echo running ;;',
  '  is-active) exit 0 ;;',
  'esac',
  'exit 0',
].join('\n')

/** The same stub on a host where systemd is not PID 1 (is-system-running -> offline). */
const SYSTEMCTL_STUB_OFFLINE = SYSTEMCTL_STUB.replace('echo running', 'echo offline')

/** A stub that reloads nothing: daemon-reload fails, everything else answers. */
const SYSTEMCTL_STUB_RELOAD_FAILS = SYSTEMCTL_STUB.replace(
  '  is-active) exit 0 ;;',
  '  is-active) exit 0 ;;\n  daemon-reload) echo "Failed to reload daemon" >&2; exit 1 ;;',
)

/**
 * A scratch install tree that already holds an OLD binary-mode payload, plus
 * the deploy/ scripts and a RELEASE_API file listing the target tag.
 */
function seedBinaryUpdate(opts: {
  currentVersion: string
  targetVersion: string
  includeDb?: boolean
}): ReturnType<typeof seedBinaryUpdateShape> {
  return seedBinaryUpdateShape(opts)
}

function seedBinaryUpdateShape(opts: {
  currentVersion: string
  targetVersion: string
  includeDb?: boolean
}) {
  const root = mkdtempSync(join(tmpdir(), 'synapto-binu-'))
  const deployDir = join(root, 'deploy')
  const stubsDir = join(root, 'stubs')
  const installDir = join(root, 'opt', U_APP)
  const runDir = join(root, 'run')
  const privLog = join(root, 'privileged.log')
  const unitFile = join(root, 'unit', `${U_APP}.service`)
  // Copy only the scripts update.sh actually needs; the flat `common.sh` only
  // exists inside an installed ${RUN_DIR}/scripts, never in the repo.
  mkdirSync(deployDir, { recursive: true })
  for (const f of ['update.sh', 'updater.sh', 'uninstall.sh']) {
    cpSync(join(import.meta.dir, f), join(deployDir, f))
  }
  mkdirSync(join(deployDir, 'lib'), { recursive: true })
  cpSync(join(import.meta.dir, 'lib', 'common.sh'), join(deployDir, 'lib', 'common.sh'))
  mkdirSync(join(deployDir, 'hooks'), { recursive: true })
  for (const f of ['pre-update', 'post-update']) {
    cpSync(join(import.meta.dir, 'hooks', f), join(deployDir, 'hooks', f))
  }
  mkdirSync(stubsDir, { recursive: true })
  mkdirSync(join(root, 'unit'), { recursive: true })
  mkdirSync(join(runDir, 'scripts'), { recursive: true })
  mkdirSync(join(runDir, 'hooks'), { recursive: true })
  mkdirSync(installDir, { recursive: true })
  mkdirSync(join(installDir, 'lib'), { recursive: true })
  writeFileSync(privLog, '')

  // An old, already-installed payload (as a previous release left it).
  writeFileSync(join(installDir, U_APP), `#!/bin/sh\necho "${U_APP} ${opts.currentVersion}"\n`)
  chmodSync(join(installDir, U_APP), 0o755)
  writeFileSync(join(installDir, 'vec0.so'), 'old vec0\n')
  writeFileSync(join(installDir, 'lib', 'libonnxruntime.so.1'), 'old onnxruntime\n')

  // The NEW payload as a release directory.
  const releases = join(root, 'releases')
  const tag = `v${opts.targetVersion}`
  const build = join(root, 'build', `${U_APP}-${opts.targetVersion}-linux-x86_64`)
  const payload: Record<string, string> = {
    [U_APP]: `#!/bin/sh\necho "${U_APP} v${opts.targetVersion}"\n`,
    'vec0.so': 'new vec0\n',
    'lib/libonnxruntime.so.1': 'new onnxruntime\n',
    'config.json.example': '{ "server": { "port": 3999 }, "database": { "path": "./data/synaptomind.db" } }\n',
    '.env.example': 'SYNAPTOMIND_SECRET=\n',
  }
  for (const [rel, content] of Object.entries(payload)) {
    const full = join(build, rel)
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  chmodSync(join(build, U_APP), 0o755)
  mkdirSync(join(releases, tag), { recursive: true })
  const tarRes = spawnSync(
    'tar',
    ['-czf', join(releases, tag, `${U_APP}-${tag}-linux-x86_64.tar.gz`), '-C', join(root, 'build'), `${U_APP}-${opts.targetVersion}-linux-x86_64`],
    { encoding: 'utf8' },
  )
  expect(tarRes.status, tarRes.stderr).toBe(0)

  // A file:// "RELEASE_API" — release_resolve_tag reads it with url_get, which
  // handles file:// through curl, so no HTTP server is needed.
  writeFileSync(
    join(releases, 'api.json'),
    JSON.stringify([{ tag_name: tag, draft: false }]),
  )

  if (opts.includeDb) {
    mkdirSync(join(installDir, 'data'), { recursive: true })
    spawnSync('sqlite3', [join(installDir, 'data', 'synaptomind.db'), 'create table t(x int); insert into t values (1);'], {
      encoding: 'utf8',
    })
  }

  // Helpers, hooks and the installed app.env (the layout update.sh expects).
  for (const f of ['update.sh', 'updater.sh', 'uninstall.sh']) {
    cpSync(join(import.meta.dir, f), join(runDir, 'scripts', f))
  }
  for (const f of ['pre-update', 'post-update']) {
    cpSync(join(import.meta.dir, 'hooks', f), join(runDir, 'hooks', f))
    chmodSync(join(runDir, 'hooks', f), 0o755)
  }
  cpSync(join(import.meta.dir, 'lib', 'common.sh'), join(runDir, 'scripts', 'common.sh'))

  // UNIT_FILE redirects refresh_unit away from the real /etc unit.
  const env = {
    APP_NAME: U_APP,
    APP_DESC: 'Synaptomind — thought-graph engine',
    DIST: 'binary',
    INSTALL_DIR: installDir,
    DATA_DIR: join(root, 'data'),
    RUN_DIR: runDir,
    PORT: '3999',
    RELEASES_BASE: `file://${releases}`,
    RELEASE_API: `file://${join(releases, 'api.json')}`,
    // SINGLE-QUOTED, like the shipped app.env: the file is SOURCED, so a
    // double-quoted ${TAG} would be expanded at load time to an empty string.
    ASSET_PATTERN: "'${APP_NAME}-${TAG}-${OS}-${ARCH}.tar.gz'",
    APP_VERSION_CMD: "'${BIN} --version'",
    CHECKOUT_POLICY: 'stable',
    REQUIRES_BUN: 'no',
    SYSTEM_DEP_CMDS: '',
    SERVICE_USER: '',
    SEED_FILES: 'config.json.example:config.json .env.example:.env',
    GENERATE_SECRET_IN: '.env',
    HOOKS_DIR: '',
    UNIT_FILE: unitFile,
    // No service runs in these tests, so point the post-restart poll at a
    // closed port. The poll is stubbed (see FAKE_HEALTH_STUB) to answer on the
    // first attempt; without it wait_health sleeps for the full HEALTH_TIMEOUT.
    HEALTH_URL: 'http://127.0.0.1:1/health',
    HEALTH_TIMEOUT: '1',
  }
  writeFileSync(
    join(runDir, 'scripts', 'app.env'),
    Object.entries(env)
      .map(([k, v]) => (k === 'ASSET_PATTERN' || k === 'APP_VERSION_CMD' ? `${k}=${v}` : `${k}="${v}"`))
      .join('\n') + '\n',
  )

  // The sudo guard allows: everything under the fixture root, plus the $TMPDIR
  // paths that render_systemd_unit's `mktemp -d` produces before the copy.
  const guard = [
    `"${root}"/*|"${root}"/*`,
    `"${tmpdir()}"/*|"${tmpdir()}"/*`,
  ].join('|')
  writeFileSync(join(stubsDir, 'sudo'), makeGuardedSudo(privLog, guard))
  writeFileSync(join(stubsDir, 'systemctl'), SYSTEMCTL_STUB)
  for (const s of ['sudo', 'systemctl']) chmodSync(join(stubsDir, s), 0o755)

  // The unit is rendered into $TMPDIR by render_systemd_unit before it is
  // copied to UNIT_FILE, so the sudo guard must also allow mktemp -d paths.
  // curl stub: the /health poll only. Everything else (the file:// release
  // downloads) must reach the REAL curl, so the stub passes non-health URLs
  // straight through.
  const realCurl = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(
    join(stubsDir, 'curl'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      '  case "$a" in',
      `    */health) printf '%s' "$FAKE_HEALTH_BODY"; exit 0 ;;`,
      '  esac',
      'done',
      `exec ${realCurl} "$@"`,
    ].join('\n'),
  )
  chmodSync(join(stubsDir, 'curl'), 0o755)

  const healthBody = JSON.stringify({
    status: 'ok',
    version: opts.targetVersion,
    checks: { database: 'ok', embedder: 'ok' },
  })
  return { root, deployDir, stubsDir, installDir, runDir, privLog, unitFile, healthBody, guard }
}

/** The four fields every update.sh fixture needs to be run. */
type UpdateFixture = { runDir: string; stubsDir: string; privLog: string; healthBody: string }

/**
 * Replace the fixture's /health curl stub with one that answers a SEQUENCE of
 * payloads, one per poll, repeating the last one once exhausted. FAKE_HEALTH_BODY
 * can only express a single static body, so a recovery case ("failed now,
 * healthy on the next poll") needs a counter — kept in a file, because wait_health
 * calls url_get inside a command substitution and a shell variable would be lost.
 *
 * Returns the counter file so a test can assert how many samples were consumed;
 * the HEALTH_TIMEOUT in the seeded app.env is raised from 1s to match the number
 * of samples, otherwise the gate times out after the first one.
 */
function sequenceHealth(fx: UpdateFixture, bodies: string[], timeout = 6): string {
  const realCurl = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
  const counter = join(fx.runDir, 'health-polls')
  const script = [
    `__bodies=(${bodies.map(b => `'${b}'`).join(' ')})`,
    `__poll='${counter}'`,
    '__n=$(cat "$__poll" 2>/dev/null || printf 0)',
    '__n=$((__n + 1))',
    'printf "%s" "$__n" > "$__poll"',
    '__max=${#__bodies[@]}',
    '[ "$__n" -gt "$__max" ] && __n=$__max',
    'printf "%s" "${__bodies[$((__n - 1))]}"',
  ].join('\n')
  writeFileSync(
    join(fx.stubsDir, 'curl'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      '  case "$a" in',
      '    */health)',
      script,
      '      exit 0 ;;',
      '  esac',
      'done',
      `exec ${realCurl} "$@"`,
    ].join('\n'),
  )
  chmodSync(join(fx.stubsDir, 'curl'), 0o755)
  const envFile = join(fx.runDir, 'scripts', 'app.env')
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace('HEALTH_TIMEOUT="1"', `HEALTH_TIMEOUT="${timeout}"`))
  return counter
}

function runUpdate(fx: UpdateFixture, args: string[]) {
  return spawnSync('bash', [join(fx.runDir, 'scripts', 'update.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.stubsDir}:${process.env.PATH}`,
      STUB_PRIV_LOG: fx.privLog,
      // The fake /health body must report the version update.sh is polling for,
      // otherwise wait_health times out. Tests that want a FAILING health check
      // override FAKE_HEALTH_BODY with something the version check rejects.
      FAKE_HEALTH_BODY: fx.healthBody,
    },
    timeout: 60_000,
  })
}

describe('update.sh — DIST=binary', () => {
  afterEach(() => {
    // nothing global; each test cleans its own tree
  })

  test('swaps the payload, keeps .prev for all three files, and moves the executable last', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      // New payload in place.
      expect(readFileSync(join(fx.installDir, 'vec0.so'), 'utf8')).toBe('new vec0\n')
      expect(readFileSync(join(fx.installDir, 'lib', 'libonnxruntime.so.1'), 'utf8')).toBe(
        'new onnxruntime\n',
      )
      // Previous copy kept for a no-git rollback.
      expect(readFileSync(join(fx.installDir, 'vec0.so.prev'), 'utf8')).toBe('old vec0\n')
      expect(readFileSync(join(fx.installDir, U_APP + '.prev'), 'utf8')).toContain('v0.7.1')
      expect(readFileSync(join(fx.installDir, 'lib', 'libonnxruntime.so.1.prev'), 'utf8')).toBe(
        'old onnxruntime\n',
      )
      // No staging or tarball left behind.
      const leftovers = readdirSync(fx.installDir).filter(
        (f) => f.startsWith('.stage.') || f.endsWith('.tar.gz'),
      )
      expect(leftovers).toEqual([])
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('the version guard sees an upgrade, not a downgrade (v-prefix normalisation)', () => {
    // current_version() returns app_version's "v0.7.1"; TARGET_VERSION is bare
    // "0.8.0". Unnormalised, ver_cmp "v0.7.1" "0.8.0" answers "newer" and a
    // plain upgrade is misreported as a downgrade (ADR §2.6).
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stderr).not.toContain('Downgrade')
      expect(res.stdout).toContain('Current:  v0.7.1')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('refreshes the systemd unit so LD_LIBRARY_PATH reaches an updated host', () => {
    // Audit finding 1: without this, a host updating INTO binary mode keeps a
    // unit without Environment=LD_LIBRARY_PATH and the embedder dies on
    // ERR_DLOPEN_FAILED.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, '# stale pre-binary unit\n')
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      const unit = readFileSync(fx.unitFile, 'utf8')
      expect(unit).toContain(`Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`)
      expect(unit).toContain(`ExecStart=${fx.installDir}/${U_APP}`)
      // The line must be immediately after NODE_ENV, per ADR §2.2.
      const lines = unit.split('\n')
      const i = lines.indexOf(`Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`)
      expect(lines[i - 1]).toBe('Environment=NODE_ENV=production')
      // daemon-reload must follow the write, before the restart.
      const log = readFileSync(fx.privLog, 'utf8')
      expect(log).toContain('daemon-reload')
      expect(log).not.toContain('enable')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('the pre-update hook backs up the DB before the swap, and its backup is usable', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0', includeDb: true })
    try {
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      const db = join(fx.installDir, 'data', 'synaptomind.db')
      const backups = readdirSync(`${db}.backup`)
      expect(backups).toHaveLength(1)
      const restored = spawnSync('sqlite3', [join(`${db}.backup`, backups[0]!), 'select count(*) from t'], {
        encoding: 'utf8',
      })
      expect(restored.stdout.trim()).toBe('1')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('source mode does NOT rewrite the unit', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      // Flip the installed app.env to source mode and give it a checkout.
      const envFile = join(fx.runDir, 'scripts', 'app.env')
      writeFileSync(envFile, readFileSync(envFile, 'utf8').replace('DIST="binary"', 'DIST="source"'))
      writeFileSync(fx.unitFile, '# hand-edited source unit\n')
      // update_binary is unreachable in source mode, so run --help-free path:
      // the guard rejects the missing .git before anything else.
      const res = runUpdate(fx, ['--yes'])
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('not installed at')
      // The hand-edited unit is untouched.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe('# hand-edited source unit\n')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('the recovery block names the .prev set and the mandatory DB restore', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      // Make the poll report a version update.sh did not ask for: that is a
      // health-check failure, which must exit non-zero with the recovery block.
      fx.healthBody = JSON.stringify({ status: 'ok', version: '0.0.1' })
      const res = runUpdate(fx, ['--yes'])
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('update did not finish cleanly')
      expect(res.stderr).toContain('.prev')
      expect(res.stderr).toContain('synaptomind.db.backup')
      // Migrations are forward-only: the DB restore is mandatory, not optional.
      expect(res.stderr).toContain('Restoring the DB is mandatory')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('a payload missing lib/libonnxruntime.so.1 aborts before the swap', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      // Rebuild the release tarball without the shared library.
      const tag = 'v0.8.0'
      const build = join(fx.root, 'build')
      rmSync(join(build, `${U_APP}-0.8.0-linux-x86_64`, 'lib', 'libonnxruntime.so.1'))
      const releases = join(fx.root, 'releases')
      rmSync(join(releases, tag, `${U_APP}-${tag}-linux-x86_64.tar.gz`))
      const tarRes = spawnSync(
        'tar',
        ['-czf', join(releases, tag, `${U_APP}-${tag}-linux-x86_64.tar.gz`), '-C', build, `${U_APP}-0.8.0-linux-x86_64`],
        { encoding: 'utf8' },
      )
      expect(tarRes.status, tarRes.stderr).toBe(0)

      const res = runUpdate(fx, ['--yes'])
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('lib/libonnxruntime.so.1')
      // The old payload must be intact — nothing was swapped.
      expect(readFileSync(join(fx.installDir, 'vec0.so'), 'utf8')).toBe('old vec0\n')
      expect(existsSync(join(fx.installDir, 'vec0.so.prev'))).toBe(false)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  //  The health gate must see a DEAD embedder, not wave it through as "ok".
  //
  //  A unit rendered without Environment=LD_LIBRARY_PATH makes the embedder
  //  child die on ERR_DLOPEN_FAILED in a loop. /health still answers status
  //  "ok" (the payload's status is DB-only on purpose — the gate fetches it
  //  with `curl -f`, so a 503 would discard the payload that explains the
  //  failure), which is why a gate reading only `status` reports clean success
  //  over permanently dead embeddings. The client latches the crashed state and
  //  the payload carries it as checks.embedder="failed".
  //
  //  Both directions are asserted, and the loading direction matters just as
  //  much: a first binary install legitimately answers "not ready" while the
  //  model downloads, so a gate that rejected it would break every cold install.
  //  (wait_health itself is covered in wait-health.test.ts.)
  // ══════════════════════════════════════════════════════════════════════════

  test('a dead embedder (checks.embedder=failed) fails the update and names the remedy', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      // Everything the gate checks apart from the embedder is healthy: status
      // ok and the exact version update.sh asked for.
      fx.healthBody = JSON.stringify({
        status: 'ok',
        version: '0.8.0',
        checks: { database: 'ok', embedder: 'failed' },
      })

      const res = runUpdate(fx, ['--yes'])

      expect(res.status).not.toBe(0)
      expect(res.stdout).not.toContain('Done.')
      // The specific failure, and what to do about it.
      expect(res.stderr).toContain('checks.embedder=failed')
      expect(res.stderr).toContain(`LD_LIBRARY_PATH=${fx.installDir}/lib`)
      // A failed gate is a failed update: the recovery block must be printed.
      expect(res.stderr).toContain('update did not finish cleanly')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  }, 30_000)

  test('a still-loading embedder (checks.embedder="not ready") passes the update', () => {
    // The first install of a binary: the model is still downloading. This must
    // succeed, or every cold install is reported as broken.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      fx.healthBody = JSON.stringify({
        status: 'ok',
        version: '0.8.0',
        checks: { database: 'ok', embedder: 'not ready' },
      })

      const res = runUpdate(fx, ['--yes'])

      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).toContain('Done.')
      expect(res.stderr).not.toContain('checks.embedder=failed')
      // The payload really did swap.
      expect(readFileSync(join(fx.installDir, 'vec0.so'), 'utf8')).toBe('new vec0\n')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('an embedder that recovers on the retry does not fail the update', () => {
    // The check is re-derived per sample, not latched: a crash that clears
    // itself must not fail the install it left healthy.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      const counter = sequenceHealth(
        fx,
        [
          JSON.stringify({ status: 'ok', version: '0.8.0', checks: { database: 'ok', embedder: 'failed' } }),
          JSON.stringify({ status: 'ok', version: '0.8.0', checks: { database: 'ok', embedder: 'ok' } }),
        ],
        // The gate sleeps 2s between polls; the slack keeps the second sample
        // reachable on a loaded machine.
        8,
      )

      const res = runUpdate(fx, ['--yes'])

      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).toContain('Done.')
      // The failing sample was really served first — otherwise this test would
      // pass on a gate that never saw a failure.
      expect(Number(readFileSync(counter, 'utf8').trim())).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  }, 30_000)
})

// ════════════════════════════════════════════════════════════════════════════
//  A FAILED unit refresh must not report a successful binary update.
//
//  Epic-review finding (task #1039, the reviewer's own): refresh_unit
//  warn-and-continued on every failure path, so update.sh returned 0, restarted
//  the service and printed "Done." while the installed unit still lacked
//  Environment=LD_LIBRARY_PATH. The payload just swapped in is a compiled
//  binary whose embedder child cannot dlopen lib/libonnxruntime.so.1 without
//  that line, so it dies on ERR_DLOPEN_FAILED — and /health still answers
//  status "ok", which is all the health gate read (finding F1).
//
//  In binary mode a refresh that did not happen is FATAL. What must NOT become
//  fatal: source mode (no LD_LIBRARY_PATH line exists there) and a host with no
//  unit on disk to go stale (a --no-service / container install) — both
//  asserted below, so the rule cannot widen by accident.
//
//  The rendered unit is kept on failure, because the remedy cannot be "re-run
//  update.sh": the "Already up to date" guard in main() exits BEFORE
//  refresh_unit is reached again, so a re-run is a no-op.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A `cp` that fails only for the given destination and passes everything else
 * to the real cp. It has to be narrow: binary_keep_previous() uses `cp -f` for
 * the payload and refresh_unit saves the rendered unit with `cp` as well, so a
 * blanket failure would abort the swap itself and the run would exit 1 for an
 * unrelated reason.
 */
/**
 * A `cp` that fails for every destination inside `dir` — "cannot write the unit"
 * as an operator experiences it (a read-only or full unit directory).
 *
 * Matched on the DIRECTORY, not on the exact path: the unit is no longer written
 * by `cp` straight onto itself, so a stub that failed only for the unit's own
 * path would now fail NOTHING and the test would pass for the wrong reason.
 * Every cp aimed at the staging file and at the .bak is refused; every other cp
 * in the run passes through, so the payload swap still happens for real.
 */
function makeCpFailingInDir(dir: string): string {
  const realCp = spawnSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()
  return [
    '#!/usr/bin/env bash',
    'for a in "$@"; do',
    `  case "$a" in ${dir}/*)`,
    '    echo "cp: cannot create regular file $a: Permission denied" >&2; exit 1',
    '  ;; esac',
    'done',
    `exec ${realCp} "$@"`,
  ].join('\n')
}

/** Rewrite one PATH stub of an existing fixture. */
function rewriteStub(fx: ReturnType<typeof seedBinaryUpdate>, name: string, body: string): void {
  writeFileSync(join(fx.stubsDir, name), body)
  chmodSync(join(fx.stubsDir, name), 0o755)
}

describe('update.sh — a failed unit refresh is fatal in binary mode', () => {
  test('a unit that cannot be written aborts instead of reporting success', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, '# stale pre-binary unit\n')
      rewriteStub(fx, 'cp', makeCpFailingInDir(dirname(fx.unitFile)))
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
      expect(res.stdout).not.toContain('Done.')
      // The service must not be restarted on a unit that was not refreshed.
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('restart')
      // The stale unit is still the one on disk, and the payload is in place.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe('# stale pre-binary unit\n')
      expect(readFileSync(join(fx.installDir, 'vec0.so'), 'utf8')).toBe('new vec0\n')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('a refused privileged write aborts, and the service keeps running the old payload', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      const stale = '# stale pre-binary unit\n'
      writeFileSync(fx.unitFile, stale)
      // sudo exists and works for systemctl, but refuses every write primitive
      // the atomic replacement needs (no tty to ask for a password). The FIRST
      // refusal now lands on `chmod 600` of the staging file rather than on the
      // copy, so the log is asserted on the file being written, not on which
      // command happened to be refused first.
      rewriteStub(fx, 'sudo', makeGuardedSudo(fx.privLog, fx.guard, { refuse: ['cp', 'chmod', 'mv', 'touch'] }))
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
      expect(res.stdout).not.toContain('Done.')
      const log = readFileSync(fx.privLog, 'utf8')
      expect(log).toContain(dirname(fx.unitFile))
      expect(log).not.toContain('restart')
      // A refused write is a no-op: the operator's unit is byte for byte intact.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(stale)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('systemd down with a unit already on disk aborts (that unit governs the next boot)', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, '# stale pre-binary unit\n')
      rewriteStub(fx, 'systemctl', SYSTEMCTL_STUB_OFFLINE)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
      expect(res.stdout).not.toContain('Done.')
      expect(readFileSync(fx.unitFile, 'utf8')).toBe('# stale pre-binary unit\n')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('a failed daemon-reload aborts too — a restart would apply the old body', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, '# stale pre-binary unit\n')
      rewriteStub(fx, 'systemctl', SYSTEMCTL_STUB_RELOAD_FAILS)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
      expect(res.stdout).not.toContain('Done.')
      expect(res.stderr).toContain('daemon-reload')
      // The unit on disk IS the refreshed one here, so the remedy must not
      // install the unit over itself.
      expect(readFileSync(fx.unitFile, 'utf8')).toContain(
        `Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`,
      )
      expect(res.stderr).not.toContain('sudo install')
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('restart')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('the failure names what failed, the line at stake, and a remedy that works', () => {
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, '# stale pre-binary unit\n')
      rewriteStub(fx, 'cp', makeCpFailingInDir(dirname(fx.unitFile)))
      const res = runUpdate(fx, ['--yes'])
      const err = res.stderr
      // What failed, in words an operator can act on.
      expect(err).toContain(fx.unitFile)
      expect(err).toContain(`Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`)
      expect(err).toContain('ERR_DLOPEN_FAILED')
      // The remedy must point at a file that really exists and really carries
      // the line, not just at words.
      const saved = err.match(/rendered:\s*(\S+)/)?.[1]
      expect(saved, `no rendered-unit path in:\n${err}`).toBeTruthy()
      expect(readFileSync(saved!, 'utf8')).toContain(
        `Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`,
      )
      expect(err).toContain('sudo install')
      expect(err).toContain('daemon-reload')
      // The rollback block still ships: the payload is already swapped, and
      // migrations are forward-only.
      expect(err).toContain('update did not finish cleanly')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('no unit on disk and no systemd is NOT fatal — there is nothing stale to refresh', () => {
    // The counter-test that keeps the rule honest: a --no-service / container
    // binary install has no unit to go stale, so the update must still succeed.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      rewriteStub(fx, 'systemctl', SYSTEMCTL_STUB_OFFLINE)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).toContain('Done.')
      expect(readFileSync(join(fx.installDir, 'vec0.so'), 'utf8')).toBe('new vec0\n')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })
})

// ── Source mode ──────────────────────────────────────────────────────────────

/**
 * A DIST=source install: a real clone sitting at v0.7.1 whose origin carries a
 * newer stable tag, plus the installed-layout state dir. REQUIRES_BUN=no keeps
 * the fixture off `bun install` — the unit decision does not depend on it.
 */
function seedSourceUpdate() {
  const origin = seedTwoStableTagsRepo('v0.7.1', 'v0.8.0', {
    'package.json': '{"name":"synaptomind","version":"0.7.1"}',
  })
  const root = mkdtempSync(join(tmpdir(), 'synapto-src-'))
  const installDir = join(root, 'opt', U_APP)
  const runDir = join(root, 'run')
  const stubsDir = join(root, 'stubs')
  const privLog = join(root, 'privileged.log')
  const unitFile = join(root, 'unit', `${U_APP}.service`)
  mkdirSync(join(root, 'unit'), { recursive: true })
  mkdirSync(join(runDir, 'scripts'), { recursive: true })
  mkdirSync(join(runDir, 'hooks'), { recursive: true })
  mkdirSync(stubsDir, { recursive: true })
  writeFileSync(privLog, '')

  const clone = spawnSync('git', ['clone', '-q', origin, installDir], { encoding: 'utf8' })
  expect(clone.status, clone.stderr).toBe(0)
  // Park the installed checkout on the OLD tag, so the run is a real upgrade.
  const co = spawnSync('git', ['-C', installDir, 'checkout', '-q', '--force', 'v0.7.1'], {
    encoding: 'utf8',
  })
  expect(co.status, co.stderr).toBe(0)

  for (const f of ['update.sh', 'updater.sh', 'uninstall.sh']) {
    cpSync(join(import.meta.dir, f), join(runDir, 'scripts', f))
  }
  for (const f of ['pre-update', 'post-update']) {
    cpSync(join(import.meta.dir, 'hooks', f), join(runDir, 'hooks', f))
    chmodSync(join(runDir, 'hooks', f), 0o755)
  }
  cpSync(join(import.meta.dir, 'lib', 'common.sh'), join(runDir, 'scripts', 'common.sh'))

  const guard = [`"${root}"/*|"${root}"/*`, `"${tmpdir()}"/*|"${tmpdir()}"/*`].join('|')
  writeFileSync(join(stubsDir, 'sudo'), makeGuardedSudo(privLog, guard))
  writeFileSync(join(stubsDir, 'systemctl'), SYSTEMCTL_STUB)
  for (const s of ['sudo', 'systemctl']) chmodSync(join(stubsDir, s), 0o755)
  const realCurl = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(
    join(stubsDir, 'curl'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do case "$a" in */health) printf \'%s\' "$FAKE_HEALTH_BODY"; exit 0 ;; esac; done',
      `exec ${realCurl} "$@"`,
    ].join('\n'),
  )
  chmodSync(join(stubsDir, 'curl'), 0o755)

  const env = {
    APP_NAME: U_APP,
    APP_DESC: 'Synaptomind — thought-graph engine',
    DIST: 'source',
    INSTALL_DIR: installDir,
    DATA_DIR: join(root, 'data'),
    RUN_DIR: runDir,
    PORT: '3999',
    RELEASES_BASE: '',
    RELEASE_API: '',
    ASSET_PATTERN: "'${APP_NAME}-${TAG}-${OS}-${ARCH}.tar.gz'",
    APP_VERSION_CMD: "'${BIN} --version'",
    CHECKOUT_POLICY: 'stable',
    REQUIRES_BUN: 'no',
    SYSTEM_DEP_CMDS: '',
    SERVICE_USER: '',
    SEED_FILES: 'config.json.example:config.json .env.example:.env',
    GENERATE_SECRET_IN: '.env',
    HOOKS_DIR: '',
    UNIT_FILE: unitFile,
    HEALTH_URL: 'http://127.0.0.1:1/health',
    HEALTH_TIMEOUT: '1',
  }
  writeFileSync(
    join(runDir, 'scripts', 'app.env'),
    Object.entries(env)
      .map(([k, v]) => (k === 'ASSET_PATTERN' || k === 'APP_VERSION_CMD' ? `${k}=${v}` : `${k}="${v}"`))
      .join('\n') + '\n',
  )

  const healthBody = JSON.stringify({
    status: 'ok',
    version: '0.8.0',
    checks: { database: 'ok', embedder: 'ok' },
  })
  return { root, origin, stubsDir, installDir, runDir, privLog, unitFile, healthBody, guard }
}

// ════════════════════════════════════════════════════════════════════════════
//  updater.sh in DIST=binary — the two changes ADR 0001 §2.9 sanctions and
//  nothing else: the DIST guard must accept `binary`, and the version read must
//  prefer app_version. The frozen contract (path, flags, exit codes,
//  stable-only) is untouched and still asserted by the suites above.
// ════════════════════════════════════════════════════════════════════════════

describe('update.sh — source mode delivers the restart policy surgically', () => {
  // Production is DIST=source (ExecStart=bun run start), so refresh_unit()'s
  // source-mode early return — correct while the rendered body was identical for
  // source mode — made the template's Restart= line undeliverable to exactly the
  // hosts that had the outage. ensure_restart_policy() therefore rewrites ONE
  // line in place instead of re-rendering, which is what keeps the hand-edit
  // invariant of the block above intact.

  const HAND_EDITED = [
    '[Unit]',
    'Description=Synaptomind — thought-graph engine (v0.7.1)',
    'Group=opencode',
    'StartLimitIntervalSec=60',
    '',
    '[Service]',
    'Type=simple',
    'Environment=HAND_EDITED=yes',
    'ExecStart=/usr/local/bin/bun run start',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')

  test('a source update rewrites only the Restart= line and keeps every hand edit', () => {
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)

      const unit = readFileSync(fx.unitFile, 'utf8')
      expect(unit).toContain('\nRestart=always\n')
      expect(unit).not.toContain('Restart=on-failure')
      // The whole point of the surgical path: the operator's unit survives.
      expect(unit).toContain('Description=Synaptomind — thought-graph engine (v0.7.1)')
      expect(unit).toContain('Group=opencode')
      expect(unit).toContain('Environment=HAND_EDITED=yes')
      expect(unit).toContain('ExecStart=/usr/local/bin/bun run start')
      // Exactly one Restart directive — a second one would win in systemd.
      expect(unit.split('\n').filter((l) => /^Restart=/.test(l))).toHaveLength(1)
      expect(res.stdout).toContain('now carries Restart=always (was: Restart=on-failure)')
      // systemd must read it, and only then does the restart apply it.
      expect(readFileSync(fx.privLog, 'utf8')).toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a unit already on Restart=always is not rewritten and does not daemon-reload', () => {
    // Idempotency: an update that changed nothing must not spend a privileged
    // write plus a daemon-reload on every run.
    const fx = seedSourceUpdate()
    try {
      const already = HAND_EDITED.replace('Restart=on-failure', 'Restart=always')
      writeFileSync(fx.unitFile, already)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(already)
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a unit with no Restart= line is left byte-identical and the remedy is named', () => {
    // Nothing is ever INSERTED: where the directive belongs is not something to
    // guess, and a comment-only unit must survive untouched. This is the same
    // invariant the "source mode leaves the unit alone" block asserts, reached
    // through a real update instead of an aborted one.
    const fx = seedSourceUpdate()
    try {
      const unit = '# hand-edited source unit\n[Service]\nExecStart=/usr/local/bin/bun run start\n'
      writeFileSync(fx.unitFile, unit)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(unit)
      expect(res.stderr).toContain('it declares no Restart= line')
      expect(res.stderr).toContain('Restart=always')
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a unit that cannot be rewritten warns and still lets the update succeed', () => {
    // Never fatal, unlike refresh_unit() in binary mode: an undelivered restart
    // policy leaves a running service, whereas failing here would block updates
    // on an otherwise healthy host.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      writeFileSync(
        join(fx.stubsDir, 'sudo'),
        makeGuardedSudo(fx.privLog, fx.guard, { refuse: ['cp'] }),
      )
      chmodSync(join(fx.stubsDir, 'sudo'), 0o755)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).toContain('Done. Now at 0.8.0.')
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(HAND_EDITED)
      expect(res.stderr).toContain('Restart policy unchanged')
      expect(res.stderr).toContain('Restart=on-failure')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a unit with no Restart= line keeps the invariant its name claims', () => {
    // The case the deleted "source mode leaves the unit alone" block used to
    // stand for, but it asserted only that the update exits 0 — it passed
    // because its fixture unit had no Restart= line, so it could not have
    // detected a re-render. Here the unit is a REAL one that lacks the
    // directive, so the bytes on disk after the run are the claim.
    const fx = seedSourceUpdate()
    try {
      const unit = '# hand-edited source unit\n[Service]\nExecStart=/usr/local/bin/bun run start\n'
      writeFileSync(fx.unitFile, unit)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).toContain('Done. Now at 0.8.0.')
      // Nothing was ever inserted: where the directive belongs is not guessed.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(unit)
      expect(res.stderr).toContain('it declares no Restart= line')
      const log = readFileSync(fx.privLog, 'utf8')
      expect(log).not.toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  The write to the LIVE unit: atomic, recoverable, and honest about the file
//  on disk. Every test here reproduced a defect in the first version of
//  ensure_restart_policy (d9ff4bb, review of #1082) — a truncated unit reported
//  as unchanged, a widened mode, an unreadable unit misreported, and a
//  last-wins duplicate that skipped the update silently.
// ════════════════════════════════════════════════════════════════════════════

describe('update.sh — the restart-policy write is atomic and honest', () => {
  const HAND_EDITED = [
    '[Unit]',
    'Description=Synaptomind — thought-graph engine (v0.7.1)',
    'Group=opencode',
    'StartLimitIntervalSec=60',
    '',
    '[Service]',
    'Type=simple',
    'Environment=HAND_EDITED=yes',
    'ExecStart=/usr/local/bin/bun run start',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')

  /**
   * A `cp` that dies after truncating its destination, the way cp(1) behaves
   * when the write fails with ENOSPC/EIO or the process is killed mid-copy.
   * Every other cp in the run passes through, so only the unit write fails.
   * Installed INTO the fixture root (not the repo), never system-wide.
   */
  function breakCpForTheUnit(fx: ReturnType<typeof seedSourceUpdate>): void {
    const real = spawnSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()
    const p = join(fx.stubsDir, 'cp')
    writeFileSync(
      p,
      [
        '#!/usr/bin/env bash',
        // Every cp aimed at the unit's own directory dies after truncating:
        // the staged body and the .bak copy. Every other cp passes through, so
        // the rest of the update still runs for real.
        `dst="\${@: -1}"; src="\${@: -2:1}"`,
        `case "$dst" in ${dirname(fx.unitFile)}/*) ;; *) exec ${real} "$@" ;; esac`,
        ': > "$dst"                     # cp(1) opens the destination O_TRUNC...',
        'head -c 24 "$src" > "$dst"     # ...and only part of the payload lands',
        'echo "cp: error writing $dst: No space left on device" >&2',
        'exit 1',
      ].join('\n'),
    )
    chmodSync(p, 0o755)
  }

  test('a copy that dies partway leaves the live unit intact and reports the real state', () => {
    // The counterexample from the review: the unit went 711 -> 24 bytes while
    // stderr said "Restart policy unchanged ... it still says
    // Restart=on-failure" — both halves false, the file no longer contained
    // Restart= at all, and the staged good copy was then deleted.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      breakCpForTheUnit(fx)
      const res = runUpdate(fx, ['--yes'])
      // Never fatal: a running service beats a blocked update.
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).toContain('Done. Now at 0.8.0.')
      // The unit is BYTE-IDENTICAL: not truncated, not half-written.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(HAND_EDITED)
      // And the message describes that file, not the one we meant to write.
      expect(res.stderr).toContain('Restart policy unchanged')
      expect(res.stderr).toContain('Restart=on-failure')
      expect(res.stderr).toContain('was NOT touched')
      // systemd must not be told to reload a unit that did not change.
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a successful rewrite keeps the previous unit as <unit>.bak', () => {
    // The binary path keeps a `saved=` artifact for exactly this case
    // (refresh_unit); a plain re-run cannot fix a bad refresh because main()'s
    // "already up to date" guard returns first, so the operator needs the old
    // file as a file.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(readFileSync(fx.unitFile, 'utf8')).toContain('\nRestart=always\n')
      const backup = `${fx.unitFile}.bak`
      expect(existsSync(backup), 'the pre-change unit must be recoverable').toBe(true)
      expect(readFileSync(backup, 'utf8')).toBe(HAND_EDITED)
      expect(res.stdout).toContain('previous unit kept at')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a hand-edited unit keeps its mode instead of being widened to 644', () => {
    // cp -f over an EXISTING file does not change its mode, so the old chmod 644
    // bought nothing and only ever widened a unit that may carry
    // Environment= secrets — which is the case this function exists to serve.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      chmodSync(fx.unitFile, 0o600)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(readFileSync(fx.unitFile, 'utf8')).toContain('\nRestart=always\n')
      expect(statSync(fx.unitFile).mode & 0o777).toBe(0o600)
      // The recovery copy is a copy of the operator's file, mode and all.
      expect(statSync(`${fx.unitFile}.bak`).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('an unreadable unit is reported as unreadable, not as declaring no Restart= line', () => {
    // The greps used to swallow their errors (2>/dev/null, || true), so a
    // mode-000 unit produced an empty result and was reported as declaring no
    // Restart= line — with a remedy (edit the unit) the operator cannot apply
    // for the very permission reason that made it unreadable.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      chmodSync(fx.unitFile, 0o000)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stderr).toContain('could not be READ')
      // The distinction the fix exists for: a read FAILURE is not an ABSENCE.
      expect(res.stderr).not.toContain('it declares no Restart= line')
      expect(res.stderr).not.toContain('add \'Restart=always\' under [Service]')
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('daemon-reload')
      chmodSync(fx.unitFile, 0o644)
      // Nothing was written, so the file is still the operator's byte for byte.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(HAND_EDITED)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a duplicate Restart= line is judged on the EFFECTIVE one (last wins)', () => {
    // The idempotency grep matched Restart=anywhere=always, so a unit with
    // `Restart=always` followed by `Restart=no` exited 0 silently: no write, no
    // warning, and the effective policy stayed `no` — the exact outage shape
    // this change exists to prevent.
    const fx = seedSourceUpdate()
    try {
      const dup = HAND_EDITED.replace('Restart=on-failure', 'Restart=always\nRestart=no')
      writeFileSync(fx.unitFile, dup)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      const unit = readFileSync(fx.unitFile, 'utf8')
      // Collapsed onto the policy we want, so last-wins cannot pick `no`.
      expect(unit.split('\n').filter((l) => /^Restart=/.test(l))).toEqual(['Restart=always'])
      // The message names the effective directive it replaced.
      expect(res.stdout).toContain('was: Restart=no')
      expect(readFileSync(fx.privLog, 'utf8')).toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('an already-correct unit is left byte-identical with no .bak and no reload', () => {
    const fx = seedSourceUpdate()
    try {
      const already = HAND_EDITED.replace('Restart=on-failure', 'Restart=always')
      writeFileSync(fx.unitFile, already)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(already)
      // Idempotent means no privileged write at all: no backup, no reload.
      expect(existsSync(`${fx.unitFile}.bak`)).toBe(false)
      expect(readFileSync(fx.privLog, 'utf8')).not.toContain('daemon-reload')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('every rewrite leaves exactly one Restart= line, hand edits intact', () => {
    // The surgical invariant, on a unit whose edits must all survive: the
    // rewrite is a rename onto a sed'd body, so nothing else can drift.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      const unit = readFileSync(fx.unitFile, 'utf8')
      expect(unit.split('\n').filter((l) => /^Restart=/.test(l))).toEqual(['Restart=always'])
      for (const kept of [
        'Description=Synaptomind — thought-graph engine (v0.7.1)',
        'Group=opencode',
        'Environment=HAND_EDITED=yes',
        'ExecStart=/usr/local/bin/bun run start',
        'StartLimitIntervalSec=60',
      ]) {
        expect(unit, kept).toContain(kept)
      }
      // Only the Restart= line changed, byte for byte.
      expect(unit.replace('Restart=always', 'Restart=on-failure')).toBe(HAND_EDITED)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('no staging file is left in the unit directory', () => {
    // The staged copy lives BESIDE the unit (a rename only stays atomic within
    // one filesystem), so it must not survive the run: systemd scans that
    // directory, and a leftover .synaptomind.service.new.* is litter that the
    // next update would trip over.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      const leftovers = readdirSync(dirname(fx.unitFile)).filter((f) => f.includes('.new.'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  // ── task #1094: the same block, for the two paths #1092's diff never
  // reached, plus the staging-file hazards its own fix left behind. Each test
  // below reproduces a counterexample measured against cc15c74; the same
  // fixture now serves as the direction control for the new code.
  //
  // The staging file is a dot-file whose name systemd never loads, and it now
  // lives in THREE places: the unit swap, the unit's .bak recovery copy (which
  // is itself written through the same atomic path, so a .bak is never a
  // truncated file), and — via the shared mechanism — both binary-mode writes.
  const SECRETED = [
    '[Unit]',
    'Description=Synaptomind — thought-graph engine (v0.7.1)',
    '',
    '[Service]',
    'Type=simple',
    'Environment=SYNAPTOMIND_API_TOKEN=super-secret-value',
    'ExecStart=/usr/local/bin/bun run start',
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')

  /** Every leftover staging file in the unit directory, with its mode. */
  function stagedLeftovers(unit: string): { name: string; mode: number; body: string }[] {
    return readdirSync(dirname(unit))
      .filter((f) => f.includes('.new.'))
      .map((name) => {
        const p = join(dirname(unit), name)
        return { name, mode: statSync(p).mode & 0o777, body: readFileSync(p, 'utf8') }
      })
  }

  test('a FAILED stage leaves no partial staging file in the unit directory', () => {
    // cc15c74's failure branch removed only $tmpdir, so a partial
    // .synaptomind.service.new.$$ survived: the reviewer's run left 6 of them,
    // one per update.sh process, and systemd logged "Failed to prepare filename
    // ... Invalid argument" for each. The old test above covers only the success
    // path — a green suite proved nothing about the branch that actually fails.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, HAND_EDITED)
      breakCpForTheUnit(fx)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      // The stage FAILED (cp died), and the directory is still clean.
      expect(stagedLeftovers(fx.unitFile), 'a failed stage must clean up after itself').toEqual([])
      expect(readdirSync(dirname(fx.unitFile))).toEqual([`${U_APP}.service`])
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a partial stage of a 600 unit never exposes Environment= secrets', () => {
    // The optional security finding from the #1093 re-review, reproduced with
    // the shape it needs: a 600 unit carrying a secret, a write that dies
    // partway. cc15c74 staged with `cp -p` from an awk redirect, so the staging
    // file inherited 644 (umask 022) and `chmod "$mode"` ran only AFTER a
    // successful stage — leaving the first bytes of a root-only unit readable by
    // anyone, in /etc/systemd/system in production. The pre-fix code leaked it
    // too; only this shape exposes it.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, SECRETED)
      chmodSync(fx.unitFile, 0o600)
      breakCpForTheUnit(fx)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      for (const leftover of stagedLeftovers(fx.unitFile)) {
        // Nothing is left at all (the stronger property), and if a future
        // change ever does leave a fragment it must not be group/other-readable.
        expect(leftover.mode & 0o077, `${leftover.name} must not be world-readable`).toBe(0)
        expect(leftover.body).not.toContain('super-secret-value')
      }
      // The live unit is byte-identical, and still 600.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(SECRETED)
      expect(statSync(fx.unitFile).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a successful rewrite keeps a 600 unit at 600 and secrets out of the .bak', () => {
    // The success path of the same property: the mode is the OPERATOR's, the
    // .bak is a copy of their file (mode and all), and neither is widened.
    const fx = seedSourceUpdate()
    try {
      writeFileSync(fx.unitFile, SECRETED)
      chmodSync(fx.unitFile, 0o600)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      const unit = readFileSync(fx.unitFile, 'utf8')
      expect(unit).toContain('\nRestart=always\n')
      expect(statSync(fx.unitFile).mode & 0o777).toBe(0o600)
      const backup = `${fx.unitFile}.bak`
      expect(readFileSync(backup, 'utf8')).toBe(SECRETED)
      expect(statSync(backup).mode & 0o777).toBe(0o600)
      expect(stagedLeftovers(fx.unitFile)).toEqual([])
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a symlinked unit is written THROUGH, not replaced by a regular file', () => {
    // The third #1093 finding, and a deliberate decision rather than an
    // accident: `systemctl link` puts a symlink in /etc/systemd/system, and the
    // operator edits the real file elsewhere. cc15c74's `mv -f` replaced the
    // LINK with a regular file — silently changing the unit's shape, orphaning
    // the file systemd was NOT loading — and `stat -c %a` without -L reported
    // the link's own mode (777, a symlink always is), so the resulting unit
    // landed world-writable and systemd warned about it. DECIDED: follow the
    // link and swap the file it points at; the link survives.
    //
    // Production's unit is a regular file (verified), so this is about not
    // surprising an operator who linked one.
    const fx = seedSourceUpdate()
    const real = join(fx.root, 'linked', `${U_APP}.service`)
    try {
      mkdirSync(join(fx.root, 'linked'), { recursive: true })
      writeFileSync(real, HAND_EDITED)
      chmodSync(real, 0o600)
      // seedSourceUpdate() does not pre-create the unit, so rmSync needs force.
      rmSync(fx.unitFile, { force: true })
      symlinkSync(real, fx.unitFile)

      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      // The link is still a link...
      expect(lstatSync(fx.unitFile).isSymbolicLink(), 'the link must survive the rewrite').toBe(true)
      // ...and the update landed in the file it points at.
      expect(readFileSync(real, 'utf8')).toContain('\nRestart=always\n')
      // Mode is the TARGET's (600), not the link's own 777.
      expect(statSync(real).mode & 0o777).toBe(0o600)
      // And the operator is told their link was followed, not silently ignored.
      expect(res.stdout).toContain('is a link; wrote through it to')
      // A .bak beside the link is a plain file (nothing linked it), and its mode
      // is the unit's own — not 777.
      const backup = `${fx.unitFile}.bak`
      expect(lstatSync(backup).isSymbolicLink()).toBe(false)
      expect(statSync(backup).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })

  test('a dangling link is not silently replaced by a regular file', () => {
    // The corner the follow-the-link decision has to answer. write_file_atomically
    // replaces a DANGLING link on purpose — there is no file to write through
    // and nothing that could be reading it — and says so. This path never
    // reaches it: ensure_restart_policy returns early on a unit it cannot READ,
    // and a dangling link is exactly that. The link must still be there.
    const fx = seedSourceUpdate()
    try {
      mkdirSync(join(fx.root, 'linked'), { recursive: true })
      rmSync(fx.unitFile, { force: true })
      symlinkSync(join(fx.root, 'linked', 'gone.service'), fx.unitFile)

      const res = runUpdate(fx, ['--yes'])
      expect(res.status, res.stderr + res.stdout).toBe(0)
      expect(res.stdout).not.toContain('wrote through it to')
      expect(lstatSync(fx.unitFile).isSymbolicLink(), 'a dangling link must be reported, not reshaped').toBe(true)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
      rmSync(fx.origin, { recursive: true, force: true })
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  The binary-mode write: `cp -f "$tmp" "$unit" && run_root chmod 644 "$unit"`
//  (update.sh refresh_unit) — the SAME O_TRUNC-over-the-live-unit pattern and
//  the same forced 644 that was a blocker in #1092, at an entry point outside
//  that diff. app.env ships DIST="binary", so a fresh 0.9.0 install lands here
//  and so does every binary-mode update.
// ════════════════════════════════════════════════════════════════════════════

describe('update.sh — the binary-mode unit refresh is atomic too', () => {
  /** A pre-binary unit: hand-edited, with a secret, at mode 600. */
  const STALE_SECRETED = [
    '# stale pre-binary unit, hand-edited',
    '[Unit]',
    'Description=Synaptomind — thought-graph engine (v0.7.1)',
    '',
    '[Service]',
    'Type=simple',
    'Environment=SYNAPTOMIND_API_TOKEN=super-secret-value',
    `ExecStart=/opt/synaptomind/synaptomind`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')

  /**
   * A `cp` that dies after truncating its destination, aimed at the unit
   * directory only, so the payload swap and the rest of the update still run for
   * real. Installed into the fixture's stubs, never system-wide.
   */
  function breakCpForTheUnitDir(fx: ReturnType<typeof seedBinaryUpdate>): void {
    const real = spawnSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(
      join(fx.stubsDir, 'cp'),
      [
        '#!/usr/bin/env bash',
        `dst="\${@: -1}"; src="\${@: -2:1}"`,
        `case "$dst" in ${dirname(fx.unitFile)}/*) ;; *) exec ${real} "$@" ;; esac`,
        ': > "$dst"                     # cp(1) opens the destination O_TRUNC...',
        'head -c 24 "$src" > "$dst"     # ...and only part of the payload lands',
        'echo "cp: error writing $dst: No space left on device" >&2',
        'exit 1',
      ].join('\n'),
    )
    chmodSync(join(fx.stubsDir, 'cp'), 0o755)
  }

  test('a copy that dies partway leaves the installed unit byte-identical', () => {
    // The counterexample, measured: the 265 B unit became 24 B ("[Unit]" /
    // "Description=Synap") while the message said the unit was "left unchanged"
    // and pointed the operator at a remedy. The refresh is fatal in binary mode,
    // so the run must still abort — but it must abort with the operator's unit
    // intact and the message true.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, STALE_SECRETED)
      chmodSync(fx.unitFile, 0o600)
      breakCpForTheUnitDir(fx)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(1)
      expect(res.stdout).not.toContain('Done.')
      // The unit is NOT a 24-byte stub any more.
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(STALE_SECRETED)
      expect(statSync(fx.unitFile).mode & 0o777).toBe(0o600)
      // No staging litter in the unit directory either.
      expect(readdirSync(dirname(fx.unitFile)).filter((f) => f.includes('.new.'))).toEqual([])
      // The payload swap still happened; only the unit refresh failed.
      expect(readFileSync(join(fx.installDir, 'vec0.so'), 'utf8')).toBe('new vec0\n')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('a successful refresh keeps the replaced unit as <unit>.bak', () => {
    // The rendered unit replaces a hand-edited one on a binary refresh, so the
    // body it replaces is kept: main()'s "Already up to date" guard returns
    // before refresh_unit is reached again, so a plain re-run cannot fix a bad
    // refresh. The .bak is written through the same atomic path, so it is a
    // complete copy rather than a fragment.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    try {
      writeFileSync(fx.unitFile, STALE_SECRETED)
      chmodSync(fx.unitFile, 0o600)
      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0)
      const unit = readFileSync(fx.unitFile, 'utf8')
      expect(unit).toContain(`Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`)
      // The old 644 is not imposed on a 600 unit, and the recovery copy keeps
      // the operator's file, mode and all.
      expect(statSync(fx.unitFile).mode & 0o777).toBe(0o600)
      const backup = `${fx.unitFile}.bak`
      expect(readFileSync(backup, 'utf8')).toBe(STALE_SECRETED)
      expect(statSync(backup).mode & 0o777).toBe(0o600)
      expect(readdirSync(dirname(fx.unitFile)).filter((f) => f.includes('.new.'))).toEqual([])
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('a symlinked unit is written through, not replaced at mode 777', () => {
    // Same decision as in the source-mode block, on the path a binary install
    // takes. Measured against cc15c74: the link became a regular file and the
    // unit landed mode 777 (stat -c '%a' without -L reports the link's own
    // mode), which systemd warns about as world-writable.
    const fx = seedBinaryUpdate({ currentVersion: 'v0.7.1', targetVersion: '0.8.0' })
    const real = join(fx.root, 'linked', `${U_APP}.service`)
    try {
      mkdirSync(join(fx.root, 'linked'), { recursive: true })
      writeFileSync(real, STALE_SECRETED)
      // seedSourceUpdate() does not pre-create the unit, so rmSync needs force.
      rmSync(fx.unitFile, { force: true })
      symlinkSync(real, fx.unitFile)

      const res = runUpdate(fx, ['--yes'])
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0)
      expect(lstatSync(fx.unitFile).isSymbolicLink(), 'the link must survive the refresh').toBe(true)
      expect(readFileSync(real, 'utf8')).toContain(
        `Environment=LD_LIBRARY_PATH=${fx.installDir}/lib`,
      )
      // The target's own mode, never the link's 777.
      expect(statSync(real).mode & 0o777).toBe(0o644)
      expect(res.stdout).toContain('is a link; wrote through it to')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })
})

describe('updater.sh — DIST=binary bootstrap', () => {
  test('the DIST guard accepts binary (it used to reject everything but source)', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeTrackingUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo, overrides: { DIST: 'binary' } })
    const artifact = join(FIXTURE_DIR, 'args.txt')
    const res = runUpdater(['--yes'], undefined, { UPDATER_ARTIFACT: artifact })
    expect(res.stderr).not.toContain('updater supports DIST=source only')
    expect(res.status, res.stderr + '\n' + res.stdout).toBe(0)
    expect(readFileSync(artifact, 'utf8')).toContain('v0.8.0')
  })

  test('an unknown DIST is still refused, naming both valid values', () => {
    const repo = seedSingleTagRepo('v0.8.0', {
      'deploy/update.sh': makeTrackingUpdateSh(),
      'deploy/lib/common.sh': MINIMAL_COMMON_SH,
      'package.json': '{"name":"synaptomind","version":"0.7.0"}',
    })
    setupBootstrap({ repoUrl: 'file://' + repo, overrides: { DIST: 'tarball' } })
    const res = runUpdater(['--yes'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('DIST=source or DIST=binary')
  })

  test('current_version prefers app_version for a binary install (offline, no HTTP)', () => {
    // app_version returns a v-PREFIXED string; the mark and the printed messages
    // must strip it, or the current version never matches in the menu.
    const fakeInstall = mkdtempSync(join(tmpdir(), 'synapto-binver-'))
    writeFileSync(join(fakeInstall, 'synaptomind'), '#!/bin/sh\necho "synaptomind v0.7.4"\n')
    chmodSync(join(fakeInstall, 'synaptomind'), 0o755)

    // current_version() is updater.sh's own, so probe the REAL function instead of
    // a copy: extract it from the real script by sourcing a prefix of it.
    const realUpdater = readFileSync(join(import.meta.dir, 'updater.sh'), 'utf8')
    const fnStart = realUpdater.indexOf('current_version() {')
    const fnEnd = realUpdater.indexOf('\n}\n', fnStart) + 3
    expect(fnStart, 'current_version() not found in updater.sh').toBeGreaterThan(-1)
    const script = join(FIXTURE_DIR, 'probe.sh')
    const helper = join(FIXTURE_DIR, 'common-with-app-version.sh')
    writeFileSync(helper, MINIMAL_COMMON_SH_WITH_APP_VERSION)
    // probe.sh: source the helpers, define the REAL current_version, run it.
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'APP_NAME="synaptomind"',
        'DIST="binary"',
        `APP_VERSION_CMD='\${BIN} --version'`,
        'HEALTH_URL="http://127.0.0.1:1/health"',
        '. "$1"',
        'INSTALL_DIR="$2"',
        realUpdater.slice(fnStart, fnEnd),
        'CURRENT="$(current_version)"',
        'printf \'CURRENT=%s\\n\' "$CURRENT"',
        // The menu marker compares a v-stripped tag against the raw value.
        'printf \'MENU=%s\\n\' "$([ "${CURRENT#v}" = "0.7.4" ] && echo yes || echo no)"',
        // The old comparison, unnormalised, must NOT match — that is the bug.
        'printf \'OLD_MARKER=%s\\n\' "$([ "0.7.4" = "$CURRENT" ] && echo yes || echo no)"',
      ].join('\n'),
    )
    const res = spawnSync('bash', [script, helper, fakeInstall], {
      encoding: 'utf8',
    })
    expect(res.status, res.stderr).toBe(0)
    // No HTTP fallback needed: the binary answered, v-prefixed.
    expect(res.stdout).toContain('CURRENT=v0.7.4')
    // ${CURRENT#v} matches a v-stripped tag (the fixed marker)…
    expect(res.stdout).toContain('MENU=yes')
    // …while the old unnormalised comparison does not — that was the bug.
    expect(res.stdout).toContain('OLD_MARKER=no')
    rmSync(fakeInstall, { recursive: true, force: true })
  })
})

/** MINIMAL_COMMON_SH plus app_version — what current_version() needs in binary mode. */
const MINIMAL_COMMON_SH_WITH_APP_VERSION =
  MINIMAL_COMMON_SH +
  '\n' +
  [
    'app_version() {',
    '  local bin="$1" out cmd',
    '  cmd="${APP_VERSION_CMD:-\\${BIN} --version}"',
    '  out="$(BIN="$bin" sh -c "$cmd" 2>/dev/null || true)"',
    '  out="${out%%$\'\\n\'*}"',
    '  printf \'%s\' "${out#"${APP_NAME}" }"',
    '}',
  ].join('\n')
