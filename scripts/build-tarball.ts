/**
 * Stage and pack the self-contained release tarball (ADR 0001 §2.1, §2.7, §3.1).
 *
 * `scripts/build-binary.ts` compiles the executable; this script turns the
 * checkout into the release artifact, exactly the layout of §2.1:
 *
 *   dist/synaptomind            -> <root>/synaptomind             (0755)
 *   vec0.so                     -> <root>/vec0.so                 (0644)
 *   node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1
 *                                -> <root>/lib/libonnxruntime.so.1 (0644)
 *   config.json.example         -> <root>/config.json.example      (0644)
 *   .env.example                -> <root>/.env.example             (0644)
 *
 * Packed as dist/<APP_NAME>-<TAG>-<OS>-<ARCH>.tar.gz, holding a single
 * top-level directory `<APP_NAME>-<version>-<os>-<arch>` with NO `v` prefix —
 * the name ASSET_PATTERN resolves to on the host (deploy/app.env). `<TAG>` is
 * `v<version>`, so the asset for the current version is
 * `synaptomind-v0.8.0-linux-x86_64.tar.gz`.
 *
 * The pack is verified before this script exits — the §2.1 required file set
 * is checked in the staging tree, in the archive listing, and again in a real
 * unpack, and the unpacked executable must answer the APP_VERSION_CMD contract
 * `app_version()` uses on the host. Any miss throws and exits 1.
 *
 * Usage: bun run scripts/build-tarball.ts
 *   Requires: bun run build:binary, bash scripts/setup-vec0.sh,
 *             bun install --frozen-lockfile (for libonnxruntime.so.1).
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const STAGE = join(DIST, 'stage')
const BINARY = join(DIST, 'synaptomind')
const VEC0 = join(ROOT, 'vec0.so')

/** §2.1 required set — a missing member aborts the build with a named error. */
const REQUIRED = ['synaptomind', 'vec0.so', 'lib/libonnxruntime.so.1'] as const
/** §2.1 "Optional: the two `*.example` files" — reported, never fatal. */
const OPTIONAL = ['config.json.example', '.env.example'] as const

/**
 * §2.7: v1 ships linux-x86_64 only. Native addons cannot be cross-compiled
 * (constraint 1.4.2), so the matrix is one native runner; widening this list is
 * the whole change needed for an arm64 runner (v2).
 */
const SUPPORTED = ['linux-x86_64'] as const
type Platform = (typeof SUPPORTED)[number]

/** M8 pins the onnxruntime-node path. `darwin/x64` does not exist at all. */
const ONNXRUNTIME_LIB: Record<Platform, string> = {
  'linux-x86_64': join(
    ROOT,
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
    'linux',
    'x64',
    'libonnxruntime.so.1'
  )
}

/**
 * deploy/app.env APP_VERSION_CMD — single quotes are required, because
 * load_app_env() sources the file and a double-quoted ${BIN} would expand at
 * source time (§7.1). This literal must stay a string, never a template.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the deploy contract
const APP_VERSION_CMD = '${BIN} --version'

function isSupported(platform: string): platform is Platform {
  return (SUPPORTED as readonly string[]).includes(platform)
}

function uname(flag: string): string {
  const r = spawnSync('uname', [flag], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`uname ${flag} failed: ${r.stderr?.trim()}`)
  return (r.stdout ?? '').trim()
}

/** Mirrors detect_os()/detect_arch() (deploy/lib/common.sh:105-119) on `uname`. */
function detectPlatform(): Platform {
  const sys = uname('-s')
  const os = sys === 'Linux' ? 'linux' : sys === 'Darwin' ? 'darwin' : sys.toLowerCase()
  const machine = uname('-m')
  const arch =
    machine === 'x86_64' || machine === 'amd64'
      ? 'x86_64'
      : machine === 'aarch64' || machine === 'arm64'
        ? 'arm64'
        : machine
  const platform = `${os}-${arch}`
  if (!isSupported(platform)) {
    throw new Error(
      `no release asset for ${platform}; supported: ${SUPPORTED.join(', ')} (ADR 0001 §2.7)`
    )
  }
  return platform
}

/** HEAD commit time as SOURCE_DATE_EPOCH, so the pack is byte-stable per commit. */
function sourceDateEpoch(): number {
  const r = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' })
  const secs = Number.parseInt((r.stdout ?? '').trim(), 10)
  return Number.isFinite(secs) ? secs : 0
}

function tar(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('tar', args, { encoding: 'utf8' })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function pack(archive: string, rootDir: string, mtime: number): void {
  const contents = ['-czf', archive, '-C', STAGE, rootDir]
  const reproducible = [
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    `--mtime=@${mtime}`
  ]
  const first = tar([...reproducible, ...contents])
  if (first.status === 0) return
  // BSD tar (macOS) has neither --sort nor --owner; a developer pack there
  // still has to work, so retry plain instead of failing on a GNU-only flag.
  if (!/unrecognized|unknown|illegal|not supported/i.test(first.stderr)) {
    throw new Error(`tar failed: ${first.stderr.trim()}`)
  }
  console.warn(`tar lacks reproducible flags (${first.stderr.trim().split('\n')[0]}) — packing plain`)
  const plain = tar(contents)
  if (plain.status !== 0) throw new Error(`tar failed: ${plain.stderr.trim()}`)
}

function assertTree(dir: string, label: string): void {
  for (const file of REQUIRED) {
    const path = join(dir, file)
    if (!existsSync(path)) throw new Error(`${label}: required file ${file} is missing`)
    if (statSync(path).size === 0) throw new Error(`${label}: required file ${file} is empty`)
  }
  const exe = join(dir, 'synaptomind')
  if ((statSync(exe).mode & 0o111) === 0) throw new Error(`${label}: synaptomind is not executable`)
  for (const file of OPTIONAL) {
    if (!existsSync(join(dir, file))) console.warn(`${label}: optional seed file ${file} is missing`)
  }
}

function assertArchive(entries: string[], rootDir: string, asset: string): void {
  const tops = new Set(entries.map((entry) => entry.split('/')[0]))
  if (tops.size !== 1 || !tops.has(rootDir)) {
    throw new Error(
      `${asset}: expected exactly one top-level directory ${rootDir}/, found ${[...tops].join(', ')}`
    )
  }
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`${asset}: unsafe archive entry ${entry}`)
    }
  }
  const files = new Set(
    entries.filter((e) => !e.endsWith('/')).map((e) => e.slice(`${rootDir}/`.length))
  )
  const missing = REQUIRED.filter((file) => !files.has(file))
  if (missing.length > 0) {
    throw new Error(`${asset}: required entries absent from the archive: ${missing.join(', ')}`)
  }
}

/** Runs APP_VERSION_CMD the way app_version() does: `BIN="$bin" sh -c "$cmd"`. */
function assertVersion(bin: string, expected: string): string {
  const r = spawnSync('sh', ['-c', APP_VERSION_CMD], {
    encoding: 'utf8',
    env: { ...process.env, BIN: bin }
  })
  const out = (r.stdout ?? '').split('\n')[0].trim()
  if (r.status !== 0 || out !== expected) {
    throw new Error(
      `${APP_VERSION_CMD} printed ${JSON.stringify(out)} (exit ${r.status}); expected ${JSON.stringify(expected)}`
    )
  }
  return out
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

function main(): void {
  const appName = pkg.name
  if (appName !== 'synaptomind') {
    throw new Error(
      `package name ${appName} does not match APP_NAME in deploy/app.env; the asset name would not resolve`
    )
  }
  const version = pkg.version
  const platform = detectPlatform()
  const rootDir = `${appName}-${version}-${platform}`
  const assetName = `${appName}-v${version}-${platform}.tar.gz`
  const archive = join(DIST, assetName)
  const payload = join(STAGE, rootDir)
  const lib = ONNXRUNTIME_LIB[platform]

  if (!existsSync(BINARY)) {
    throw new Error('dist/synaptomind is missing — run "bun run build:binary" first')
  }
  if (!existsSync(VEC0)) {
    throw new Error('vec0.so is missing — run "bash scripts/setup-vec0.sh" first')
  }
  if (!existsSync(lib)) {
    throw new Error(`${lib} is missing — run "bun install --frozen-lockfile" first`)
  }

  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(join(payload, 'lib'), { recursive: true })

  const staged = [
    { from: BINARY, to: join(payload, 'synaptomind'), mode: 0o755 },
    { from: VEC0, to: join(payload, 'vec0.so'), mode: 0o644 },
    { from: lib, to: join(payload, 'lib', 'libonnxruntime.so.1'), mode: 0o644 },
    { from: join(ROOT, 'config.json.example'), to: join(payload, 'config.json.example'), mode: 0o644 },
    { from: join(ROOT, '.env.example'), to: join(payload, '.env.example'), mode: 0o644 }
  ]
  for (const { from, to, mode } of staged) {
    copyFileSync(from, to)
    chmodSync(to, mode)
  }
  assertTree(payload, 'staging tree')

  rmSync(archive, { force: true })
  pack(archive, rootDir, sourceDateEpoch())
  const entries = tar(['-tzf', archive])
  if (entries.status !== 0) throw new Error(`cannot list ${assetName}: ${entries.stderr.trim()}`)
  const listing = entries.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  assertArchive(listing, rootDir, assetName)

  // Real unpack: the only proof that the artifact a host installs is sound.
  const unpack = mkdtempSync(join(tmpdir(), 'synaptomind-asset-'))
  let reported: string
  try {
    const r = tar(['-xzf', archive, '-C', unpack, '--no-same-owner'])
    if (r.status !== 0) throw new Error(`unpack of ${assetName} failed: ${r.stderr.trim()}`)
    const unpacked = join(unpack, rootDir)
    assertTree(unpacked, 'unpacked payload')
    reported = assertVersion(join(unpacked, 'synaptomind'), `${appName} v${version}`)
  } finally {
    rmSync(unpack, { recursive: true, force: true })
  }

  const unpackedBytes = REQUIRED.reduce((sum, file) => sum + statSync(join(STAGE, rootDir, file)).size, 0)
  const archiveBytes = statSync(archive).size

  console.log(`platform        ${platform} (ASSET_PATTERN: ${appName}-\${TAG}-\${OS}-\${ARCH}.tar.gz)`)
  console.log(`archive root    ${rootDir}/`)
  console.log(`asset           ${assetName}`)
  console.log(`archive bytes   ${archiveBytes} (${mib(archiveBytes)})`)
  console.log(`required bytes  ${unpackedBytes} unpacked, required set only`)
  console.log(`APP_VERSION_CMD ${APP_VERSION_CMD} -> ${JSON.stringify(reported)}`)
  console.log('archive listing:')
  for (const entry of listing) console.log(`  ${entry}`)

  // Consumed by the release job via `cat dist/asset.env >> $GITHUB_OUTPUT`.
  const manifest = [
    `ASSET_NAME=${assetName}`,
    `ASSET_BYTES=${archiveBytes}`,
    `PLATFORM=${platform}`,
    `ROOT_DIR=${rootDir}`,
    `UNPACKED_BYTES=${unpackedBytes}`
  ].join('\n')
  Bun.write(join(DIST, 'asset.env'), `${manifest}\n`)
}

try {
  main()
} catch (err) {
  console.error(`build-tarball: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}