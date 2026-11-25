/**
 * Boot the compiled release artifact and assert its embedder child comes up.
 *
 * The gap this closes (task #2685): `scripts/smoke-test.sh` runs the sources with
 * `bun run`, so nothing in CI ever started `dist/synaptomind`'s own `--embedder`
 * child. v0.26.5 shipped that way, and a binary install answered
 * `checks.embedder = "failed"` with `Cannot find package 'onnxruntime-node' from
 * '/$bunfs/root/synaptomind'` (task #2683 fixed the bundle; this is the net).
 *
 * The input is the release tarball from `scripts/build-tarball.ts`: the check
 * unpacks it, because the packed layout is what a host installs — the executable
 * finds `vec0.so` next to itself, the systemd unit points `LD_LIBRARY_PATH` at
 * `<install>/lib`, and `config.json` is seeded from `config.json.example` in the
 * install directory (deploy/lib/common.sh CONFIG_LINK_NAME). The run gets a fresh
 * database and free ports in a scratch directory, so a checkout's own config or
 * a service already bound to 3005 cannot decide the result.
 *
 * Usage: bun run scripts/artifact-health-check.ts dist/<asset>.tar.gz
 *
 *   ARTIFACT_HEALTH_TIMEOUT_MS   bounded wait for checks.embedder = "ok"
 *                                (default 300000 — sized to cover a cold model
 *                                download, and a crashing child still fails in
 *                                about a second). A malformed value aborts the
 *                                check instead of silently running with the
 *                                default.
 *   SYNAPTOMIND_EMBEDDER_CACHE_DIR
 *                                model cache handed to the artifact
 *                                (default <repo>/data/huggingface)
 *
 * A cold cache is not a product failure. With no model weights on disk the
 * artifact downloads the model into the cache directory itself
 * (src/embedder/model-validator.ts ensureModelFiles) inside the wait above,
 * which is what the 300 s default is sized for — so the first release after a
 * cache eviction, or the first run after this gate was added (no job had saved
 * the cache yet), still measures the artifact instead of failing on a missing
 * directory. If a cold run does not end in "ok", how far it got decides the
 * verdict: a run that started fetching model files (the child logs one line per
 * file, or weights appeared on disk) is reported as an infrastructure error
 * (exit 2, "cold model cache") because its window went to the download, and CI
 * saves what it fetched, so a re-run starts warm and decides. A cold run whose
 * child never touched the model failed before any download — that is the v0.26.5
 * shape (module resolution), so it stays a regression (exit 1), and so does an
 * artifact process that exits before answering.
 *
 * What `checks.embedder = "ok"` proves, and what it does not: the artifact's
 * import graph, the onnxruntime-node native binding, libonnxruntime.so.1 and the
 * model files on disk. It does NOT prove a live inference session — the
 * extractor is created lazily on the first request
 * (src/embedder/model.ts:33-56), so a model that passes the file checks but
 * fails when the session is built can still answer "ok" here.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DEFAULT_TIMEOUT_MS = 300_000
const SAMPLE_INTERVAL_MS = 1_000
const RELAY_LINES_KEPT = 200
const TEARDOWN_GRACE_MS = 15_000

const REQUIRED = ['synaptomind', 'vec0.so', 'lib/libonnxruntime.so.1', 'config.json.example']

interface Health {
  status?: string
  version?: string
  checks?: Record<string, string>
}

class CheckFailure extends Error {}
/** Not a verdict on the product: exit 2 tells the caller to re-run against a warm cache. */
class InfraFailure extends Error {}

type Subprocess = ReturnType<typeof Bun.spawn>

function fail(message: string): never {
  throw new CheckFailure(message)
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim()
  if (raw === '') return fallback
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    fail(
      `${name}=${JSON.stringify(raw)} is not a positive integer; ` +
        `refusing to guess ${fallback} ms — unset it or pass a positive integer`
    )
  }
  return Number(raw)
}

/** No weights on disk means this run must download them, which is not a product signal. */
function hasModelWeights(cacheDir: string): boolean {
  if (!existsSync(cacheDir)) return false
  try {
    return readdirSync(cacheDir, { recursive: true }).some(entry => String(entry).endsWith('.onnx'))
  } catch {
    return false
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolvePort(port)
        else rejectPort(new Error('the OS allocated no port'))
      })
    })
  })
}

async function twoFreePorts(): Promise<[number, number]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const api = await freePort()
    const mcp = await freePort()
    if (api !== mcp) return [api, mcp]
  }
  throw new Error('could not allocate two distinct ports')
}

function unpack(tarball: string, into: string): string {
  const r = spawnSync('tar', ['-xzf', tarball, '-C', into, '--no-same-owner'], { encoding: 'utf8' })
  if (r.status !== 0) fail(`unpack of ${tarball} failed: ${(r.stderr ?? '').trim()}`)
  const tops = readdirSync(into)
  if (tops.length !== 1 || !statSync(join(into, tops[0])).isDirectory()) {
    fail(`expected one top-level directory in ${tarball}, found ${tops.join(', ')}`)
  }
  return join(into, tops[0])
}

function assertPayload(payload: string): void {
  for (const file of REQUIRED) {
    const path = join(payload, file)
    if (!existsSync(path) || statSync(path).size === 0) {
      fail(`the artifact payload is missing ${file} (looked in ${payload})`)
    }
  }
}

/**
 * The child's env, derived from the caller's with every SYNAPTOMIND_/EMBEDDER_
 * variable dropped: a stray SYNAPTOMIND_DB_PATH or db path from the CI
 * environment would otherwise decide what this check measures.
 */
function artifactEnv(
  payload: string,
  dbPath: string,
  cacheDir: string,
  ports: [number, number],
  timeoutMs: number
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('SYNAPTOMIND_') || key.startsWith('EMBEDDER_')) continue
    env[key] = value
  }
  const inheritedLibs = (process.env.LD_LIBRARY_PATH ?? '').trim()
  const lib = join(payload, 'lib')
  env.LD_LIBRARY_PATH = inheritedLibs === '' ? lib : `${lib}:${inheritedLibs}`
  env.SYNAPTOMIND_HOST = '127.0.0.1'
  env.SYNAPTOMIND_PORT = String(ports[0])
  env.SYNAPTOMIND_MCP_HTTP_PORT = String(ports[1])
  env.SYNAPTOMIND_DB_PATH = dbPath
  env.SYNAPTOMIND_EMBEDDER_CACHE_DIR = cacheDir
  // The supervisor retries a crashing child until this deadline; keeping it
  // inside the polling window turns a dead embedder into a "failed" sample
  // instead of an anonymous timeout.
  env.EMBEDDER_START_TIMEOUT_MS = String(Math.max(1_000, timeoutMs - 15_000))
  return env
}

class OutputRelay {
  private readonly lines: string[] = []
  private downloadSeen = false

  constructor(private readonly label: string) {}

  // Bun types the pipe as `ReadableStream | number | undefined`: a number is the
  // fd it hands back for `stdout: 'inherit'`, which this script never asks for.
  async attach(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
    if (stream === undefined || typeof stream === 'number') return
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let pending = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) this.submit(part)
      }
      this.submit(pending)
    } catch {
      // A stream that dies with the process has already said everything useful.
    } finally {
      reader.releaseLock()
    }
  }

  private submit(raw: string): void {
    const line = raw.trimEnd()
    if (line === '') return
    console.error(`${this.label} ${line}`)
    if (line.includes('[embedder] downloading ')) this.downloadSeen = true
    this.lines.push(line)
    if (this.lines.length > RELAY_LINES_KEPT) this.lines.shift()
  }

  /** True once the child began fetching model files, so it got past module resolution. */
  sawModelDownload(): boolean {
    return this.downloadSeen
  }

  tail(): string {
    return this.lines.length === 0 ? '(no output)' : this.lines.join('\n')
  }
}

async function sample(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000)
    })
    const body = (await res.json()) as Health
    return body !== null && typeof body === 'object' ? body : null
  } catch {
    return null
  }
}

function describeSample(health: Health | null): string {
  if (health === null) return 'no answer'
  return `status=${health.status ?? '?'} checks.embedder=${JSON.stringify(health.checks?.embedder ?? 'absent')}`
}

async function teardown(proc: Subprocess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(TEARDOWN_GRACE_MS).then(() => false)
  ])
  if (exited) return
  proc.kill('SIGKILL')
  await proc.exited.catch(() => {})
}

async function main(): Promise<void> {
  const tarballArg = process.argv[2]
  if (!tarballArg) fail('usage: bun run scripts/artifact-health-check.ts <release-tarball.tar.gz>')
  const tarball = isAbsolute(tarballArg) ? tarballArg : resolve(process.cwd(), tarballArg)
  if (!existsSync(tarball)) fail(`no such tarball: ${tarball}`)

  const timeoutMs = positiveIntEnv('ARTIFACT_HEALTH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  const cacheOverride = (process.env.SYNAPTOMIND_EMBEDDER_CACHE_DIR ?? '').trim()
  const cacheDir = cacheOverride === '' ? join(ROOT, 'data', 'huggingface') : resolve(cacheOverride)
  const cold = !hasModelWeights(cacheDir)
  if (cold) {
    mkdirSync(cacheDir, { recursive: true })
    console.error(
      `[artifact-health] no model weights under ${cacheDir} — the artifact downloads them ` +
        `inside the ${timeoutMs} ms wait; a run that ends while doing so is infrastructure, ` +
        'not a product failure'
    )
  }

  const scratch = mkdtempSync(join(tmpdir(), 'synaptomind-artifact-'))
  const relay = new OutputRelay('[artifact]')
  let child: Subprocess | null = null

  try {
    const payload = unpack(tarball, scratch)
    assertPayload(payload)
    copyFileSync(join(payload, 'config.json.example'), join(payload, 'config.json'))

    const dbPath = join(scratch, 'data', 'synaptomind.db')
    const ports = await twoFreePorts()
    const env = artifactEnv(payload, dbPath, cacheDir, ports, timeoutMs)
    const binary = join(payload, 'synaptomind')

    console.error(
      `[artifact-health] payload ${payload} | db ${dbPath} | http 127.0.0.1:${ports[0]} | cache ${cacheDir}`
    )

    child = Bun.spawn([binary], { cwd: payload, env, stdout: 'pipe', stderr: 'pipe' })
    const proc = child
    void relay.attach(proc.stdout)
    void relay.attach(proc.stderr)
    let exited: number | null = null
    proc.exited.then(code => {
      exited = code
    })

    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    let lastSample = ''
    let embedder = 'absent'

    while (Date.now() < deadline) {
      if (exited !== null) {
        fail(
          `the artifact exited (code ${exited}) before /health reported a ready embedder.\n` +
            `last sample: ${lastSample || '(none)'}\n` +
            `artifact output:\n${relay.tail()}`
        )
      }
      const health = await sample(ports[0])
      embedder = health?.checks?.embedder ?? 'absent'
      const line = describeSample(health)
      if (line !== lastSample) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
        console.error(`[artifact-health] ${elapsed}s ${line}`)
        lastSample = line
      }
      if (embedder === 'ok') {
        console.error(
          `[artifact-health] OK — version ${health?.version ?? '?'}, checks ${JSON.stringify(health?.checks ?? {})}`
        )
        await teardown(proc)
        child = null
        return
      }
      // "failed" is the supervisor's latched verdict once its start deadline has
      // passed: no later sample can turn it green, so do not spend the window.
      if (embedder === 'failed') break
      await Bun.sleep(SAMPLE_INTERVAL_MS)
    }

    await teardown(proc)
    child = null
    const cause =
      embedder === 'failed'
        ? 'the embedder child failed to start'
        : `checks.embedder never became "ok" within ${timeoutMs} ms`
    const details = `last sample: ${lastSample || '(no /health answer)'}\nartifact output:\n${relay.tail()}`
    if (cold && (relay.sawModelDownload() || hasModelWeights(cacheDir))) {
      throw new InfraFailure(
        `COLD MODEL CACHE — ${cause} on a run that had to download the model into ${cacheDir}.\n` +
          `${details}\n` +
          'The window went to the download, not to the product, so this is not a verdict on it. ' +
          'Re-run: CI saves what this run fetched under the shared HuggingFace cache key, so the ' +
          'next attempt starts warm and decides. Escalate only if it stays red on a warm cache.'
      )
    }
    fail(
      `ARTIFACT EMBEDDER REGRESSION — ${cause}.\n` +
        `${details}\n` +
        'A binary install of this artifact would serve without embeddings (v0.26.5 reported ' +
        'checks.embedder="failed" with "Cannot find package \'onnxruntime-node\'").'
    )
  } finally {
    if (child !== null) await teardown(child)
    rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof InfraFailure) {
    console.error(`::error title=artifact-health: cold model cache::${message.split('\n')[0]}`)
    console.error(`artifact-health-check: ${message}`)
    process.exit(2)
  }
  console.error(`artifact-health-check: ${message}`)
  process.exit(1)
})
