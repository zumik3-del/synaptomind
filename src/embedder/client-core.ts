import { type Subprocess, spawn } from 'bun'
import { getEmbedderIdleTimeoutMs as defaultGetEmbedderIdleTimeoutMs, getEmbedderPrecache as defaultGetEmbedderPrecache } from '../db/settings'
import { insertLog as defaultInsertLog } from '../logging'
import { EmbedderNotReadyError, EmbedderOverloadedError } from '../errors'
import { isCompiled as defaultIsCompiled } from '../runtime-mode'

type EmbeddingPayload = number[] | number[][]

interface IpcMessage {
  type: 'ready' | 'exiting' | 'result' | 'error' | 'request' | 'shutdown'
  id?: string
  error?: string
  embedding?: EmbeddingPayload
  method?: string
  params?: unknown
}

type InsertLogFn = (
  level: 'debug' | 'info' | 'warning' | 'error',
  type_: string,
  message: string,
  metadata?: Record<string, unknown>,
  source?: string
) => void

export interface EmbedderClientDeps {
  getEmbedderIdleTimeoutMs: () => number
  getEmbedderPrecache: () => boolean
  insertLog: InsertLogFn
  isCompiled: () => boolean
}

const DEFAULT_DEPS: EmbedderClientDeps = {
  getEmbedderIdleTimeoutMs: defaultGetEmbedderIdleTimeoutMs,
  getEmbedderPrecache: defaultGetEmbedderPrecache,
  insertLog: defaultInsertLog,
  isCompiled: defaultIsCompiled
}

/** Embedder lifecycle, as the /health probe has to see it. */
export type EmbedderState = 'ok' | 'starting' | 'failed' | 'stopped'

const EMBEDDER_START_TIMEOUT_MS = 300_000
const EMBEDDER_REQUEST_TIMEOUT_MS = 60_000
const MAX_PENDING = 256

export class EmbedderClient {
  private proc: Subprocess | null = null
  private ready = false
  private dead = false
  private shuttingDown = false
  private nextId = 1
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null

  /** Latched when the child dies before it ever became ready; cleared by 'ready'. */
  private startFailed = false

  constructor(private deps: EmbedderClientDeps = DEFAULT_DEPS) {}

  isEmbedderReady(): boolean {
    return this.ready
  }

  /**
   * `isEmbedderReady()` alone cannot tell a first load from a dead child: a fresh
   * binary install loads the model for minutes (ready=false, and correctly so),
   * while a child that cannot dlopen its native runtime dies immediately —
   * `ready === false` either way, and ensureReady() respawns it every second, so
   * a poller watching the boolean sees a permanent "not ready".
   *
   *   ok       the child sent 'ready'
   *   starting spawned, alive, still loading the model
   *   failed   the child died before becoming ready (dlopen failure, OOM, ...)
   *   stopped  never spawned (--no-embedder, embedder.enabled=false, stdio
   *            delegation) or torn down on purpose (idle unload, shutdown)
   *
   * `failed` is LATCHED, not derived from the current child: the retry loop
   * respawns once per second, so an unlatched read would flap back to `starting`
   * between attempts. Only a real 'ready' clears it — which also covers a
   * recovered embedder, since a respawn that succeeds re-enters `ok`.
   */
  getEmbedderState(): EmbedderState {
    if (this.ready) return 'ok'
    if (this.startFailed) return 'failed'
    return this.proc && !this.dead ? 'starting' : 'stopped'
  }

  /**
   * Child argv (ADR 0001 §2.4). A compiled binary re-invokes *itself* with
   * `--embedder`, so one artifact serves both roles; source mode keeps
   * `bun run <script>`. The IPC contract is identical either way.
   */
  private getSpawnArgv(): string[] {
    // Test hook: point the client at a stub subprocess (see __fixtures__/stub-embedder.ts).
    const stub = process.env.SYNAPTOMIND_EMBEDDER_SCRIPT
    if (stub) return [process.execPath, 'run', stub]
    if (this.deps.isCompiled()) return [process.execPath, '--embedder']
    return [process.execPath, 'run', `${import.meta.dir}/embedder-process.ts`]
  }

  private rejectAllPending(err: Error) {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer)
      req.reject(err)
      this.pending.delete(id)
    }
  }

  private spawnProcess(): void {
    this.dead = false
    this.shuttingDown = false
    this.ready = false
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Suppress unhandled-rejection warnings when nobody is awaiting startup yet.
    this.readyPromise.catch(() => {})

    // Spawn the real bun binary (process.execPath), not the `bun` on PATH:
    // on Windows a launcher shim (Chocolatey/scoop) drops the fd table, so the
    // child never gets the IPC pipe — same limitation as Node.js. `process.execPath`
    // points at the running bun.exe even when the parent itself came from a shim.
    const child = spawn(this.getSpawnArgv(), {
      ipc: (message: IpcMessage) => {
        if (message.type === 'ready') {
          this.ready = true
          this.startFailed = false
          this.readyResolve?.()
          this.readyResolve = null
          return
        }

        if (message.type === 'exiting') {
          this.dead = true
          if (!this.ready && this.readyReject) {
            this.readyReject(new Error('Embedder process went idle before becoming ready'))
            this.readyReject = null
          }
          this.ready = false
          this.proc = null
          if (!this.shuttingDown) {
            this.rejectAllPending(new Error('Embedder process went idle'))
          }
          return
        }

        if (message.type === 'result' || message.type === 'error') {
          if (!message.id) return
          const req = this.pending.get(message.id)
          if (!req) return
          this.pending.delete(message.id)
          clearTimeout(req.timer)
          if (message.type === 'error') {
            req.reject(new Error(message.error ?? 'Unknown embedder error'))
            return
          }
          const emb = message.embedding
          if (Array.isArray(emb?.[0])) {
            req.resolve((emb as number[][]).map(a => new Float32Array(a)))
          } else if (emb !== undefined) {
            req.resolve(new Float32Array(emb as number[]))
          } else {
            req.reject(new Error('Malformed embedder response'))
          }
          return
        }
      },
      env: {
        ...process.env,
        EMBEDDER_PRECACHE: this.deps.getEmbedderPrecache() ? 'true' : 'false',
        EMBEDDER_IDLE_TIMEOUT: String(this.deps.getEmbedderIdleTimeoutMs())
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })

    this.proc = child

    // Capture child stdout/stderr into the structured log so embedder diagnostics
    // (model load failures, ONNX errors, etc.) surface in the same log database as
    // the parent service instead of being swallowed by the deployment runtime.
    // The raw line goes into metadata.output so the message stays a structured
    // summary, consistent with the rest of the codebase (levels use the canonical
    // 'info'/'warning' strings — stdout=progress, stderr=diagnostics).
    const pipeStream = async (
      stream: ReadableStream<Uint8Array> | undefined,
      streamName: 'stdout' | 'stderr',
      level: 'info' | 'warning' | 'error'
    ): Promise<void> => {
      if (!stream) return
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            this.deps.insertLog(level, 'embedder', `Embedder ${streamName} output`, { stream: streamName, output: trimmed })
          }
        }
        const tail = buf.trim()
        if (tail) this.deps.insertLog(level, 'embedder', `Embedder ${streamName} output`, { stream: streamName, output: tail })
      } catch (err) {
        this.deps.insertLog('error', 'embedder', `stdout/stderr reader failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    void pipeStream(child.stdout as unknown as ReadableStream<Uint8Array> | undefined, 'stdout', 'info')
    void pipeStream(child.stderr as unknown as ReadableStream<Uint8Array> | undefined, 'stderr', 'warning')

    child.exited
      .then(code => {
        if (this.proc === child) this.proc = null
        if (!this.dead && !this.shuttingDown) {
          console.error(`[embedder] process exited unexpectedly with code ${code}`)
          // Same guard as the message above: an 'exiting' IPC (idle unload) or a
          // deliberate teardown already set dead/shuttingDown, so this only
          // latches a crash — including the ERR_DLOPEN_FAILED crash loop a unit
          // rendered without LD_LIBRARY_PATH produces (ADR 0001 §2.2).
          this.startFailed = true
        }
        if (!this.shuttingDown && !this.ready && this.readyReject) {
          this.readyReject(new Error(`Embedder process exited before becoming ready (code ${code})`))
          this.readyReject = null
        }
        this.dead = true
        this.ready = false
        if (!this.shuttingDown) {
          this.rejectAllPending(new Error('Embedder process crashed'))
        }
      })
      .catch(() => {})
  }

  private async ensureReady(): Promise<void> {
    const deadline = Date.now() + EMBEDDER_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.ready) return
      if (!this.proc || this.dead) this.spawnProcess()
      const p = this.readyPromise
      if (!p) continue
      const remaining = deadline - Date.now()
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new EmbedderNotReadyError('Embedder process failed to start within 5 min')), remaining)
      )
      try {
        await Promise.race([p, timeout])
        return
      } catch {
        if (!this.ready) {
          this.dead = true
          this.proc = null
        }
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    throw new EmbedderNotReadyError('Embedder process failed to start within 5 min')
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.pending.size >= MAX_PENDING) {
        reject(new EmbedderOverloadedError(`Embedder queue full (${this.pending.size}/${MAX_PENDING}); try again later`))
        return
      }
      const id = String(this.nextId++)
      const timer = setTimeout(() => {
        const req = this.pending.get(id)
        if (req) {
          this.pending.delete(id)
          req.reject(new Error('Embedder request timed out after 60s'))
        }
      }, EMBEDDER_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.proc || this.dead) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new EmbedderNotReadyError('Embedder process not available'))
        return
      }
      try {
        this.proc.send({ type: 'request', id, method, params })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        this.dead = true
        this.ready = false
        reject(new Error('Failed to send request to embedder process'))
      }
    })
  }

  async startEmbedderProcess(): Promise<void> {
    this.spawnProcess()
    await this.ensureReady()
    console.error('[embedder] child process started')
  }

  async stopEmbedderProcess(): Promise<void> {
    await this.teardownProcess('Embedder shutting down')
  }

  private async waitForExit(p: Subprocess): Promise<void> {
    try {
      await p.exited
    } catch {}
  }

  /** Shared teardown: graceful shutdown IPC, 3s exit race, kill, state reset. */
  private async teardownProcess(reason: string): Promise<void> {
    this.shuttingDown = true
    if (this.proc) {
      try {
        this.proc.send?.({ type: 'shutdown' })
      } catch {}
      await Promise.race([this.waitForExit(this.proc), new Promise(r => setTimeout(r, 3000))])
      try {
        this.proc.kill()
      } catch {}
    }
    this.proc = null
    this.ready = false
    this.dead = true
    this.rejectAllPending(new Error(reason))
    this.shuttingDown = false
  }

  async restartEmbedder(): Promise<void> {
    await this.teardownProcess('Embedder restarting')
    this.spawnProcess()
    await this.ensureReady()
  }

  async generateEmbedding(text: string): Promise<Float32Array> {
    await this.ensureReady()
    return this.sendRequest('embed', { text }) as Promise<Float32Array>
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    await this.ensureReady()
    return this.sendRequest('embed_batch', { texts }) as Promise<Float32Array[]>
  }
}

const defaultClient = new EmbedderClient()

export function isEmbedderReady(): boolean {
  return defaultClient.isEmbedderReady()
}

export function getEmbedderState(): EmbedderState {
  return defaultClient.getEmbedderState()
}

export async function startEmbedderProcess(): Promise<void> {
  return defaultClient.startEmbedderProcess()
}

export async function stopEmbedderProcess(): Promise<void> {
  return defaultClient.stopEmbedderProcess()
}

export async function restartEmbedder(): Promise<void> {
  return defaultClient.restartEmbedder()
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  return defaultClient.generateEmbedding(text)
}

export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  return defaultClient.generateEmbeddings(texts)
}
