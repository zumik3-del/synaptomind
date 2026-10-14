import { type Subprocess, spawn } from 'bun'
import { getDb } from '../db/container'
import { getEmbedderIdleTimeoutMs, getEmbedderPrecache } from '../db/settings'
import { insertLog as defaultInsertLog } from '../logging'
import { EmbedderNotReadyError } from '../errors'
import { isCompiled as defaultIsCompiled } from '../runtime-mode'
import { IpcClient, type IpcMessage } from './ipc-client'

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

// The db accessors are db-first, so the deps keep their zero-arg shape and the
// default implementations resolve the singleton lazily at spawn time.
const DEFAULT_DEPS: EmbedderClientDeps = {
  getEmbedderIdleTimeoutMs: () => getEmbedderIdleTimeoutMs(getDb()),
  getEmbedderPrecache: () => getEmbedderPrecache(getDb()),
  insertLog: defaultInsertLog,
  isCompiled: defaultIsCompiled
}

/** Embedder lifecycle, as the /health probe has to see it. */
export type EmbedderState = 'ok' | 'starting' | 'failed' | 'stopped'

const EMBEDDER_START_TIMEOUT_MS = 300_000

/**
 * Texts per `embed_batch` IPC request. The 60 s request timeout is per request,
 * so an unbounded batch (a job embedding thousands of thoughts at once) used to
 * die on one slow request with no way to see progress. At the model's ~5-20 ms
 * per text this chunk is a few seconds at worst — far below the timeout — while
 * still amortising IPC overhead, and it bounds what a single lost request costs.
 *
 * Exported so tests assert against the real value instead of a copy (task #1569).
 */
export const EMBEDDER_BATCH_CHUNK = 64

export class EmbedderClient {
  private proc: Subprocess | null = null
  private ready = false
  private dead = false
  private shuttingDown = false
  private ipc = new IpcClient({
    getProc: () => this.proc,
    isAlive: () => !this.dead,
    onSendFailure: () => {
      this.dead = true
      this.ready = false
    }
  })
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
            this.ipc.rejectAllPending(new Error('Embedder process went idle'))
          }
          return
        }

        this.ipc.dispatch(message)
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
          this.ipc.rejectAllPending(new Error('Embedder process crashed'))
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
    return this.ipc.sendRequest(method, params)
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
    this.ipc.rejectAllPending(new Error(reason))
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

  /**
   * One vector per input text, in input order. The list is sent as
   * `ceil(N / EMBEDDER_BATCH_CHUNK)` sequential `embed_batch` requests so a
   * single request can no longer blow the per-request timeout; the requests run
   * in order, so results stay positionally aligned with `texts`.
   */
  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.ensureReady()
    const embeddings: Float32Array[] = []
    for (let i = 0; i < texts.length; i += EMBEDDER_BATCH_CHUNK) {
      const chunk = texts.slice(i, i + EMBEDDER_BATCH_CHUNK)
      const batch = (await this.sendRequest('embed_batch', { texts: chunk })) as Float32Array[]
      embeddings.push(...batch)
    }
    return embeddings
  }
}
