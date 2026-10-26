import { type Subprocess, spawn } from 'bun'
import { config } from '../config'
import { insertLog as defaultInsertLog } from '../logging'
import { EmbedderNotReadyError, EmbedderUnavailableError } from '../errors'
import { isCompiled as defaultIsCompiled } from '../runtime-mode'
import { IpcClient } from './ipc-client'
import type { IpcMessage } from './ipc-protocol'

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

export const DEFAULT_DEPS: EmbedderClientDeps = {
  // Config/env only: the `_meta` runtime overrides this used to read had no
  // production writer and were removed in task #2201.
  getEmbedderIdleTimeoutMs: () => config.embedder.idleTimeoutMs,
  getEmbedderPrecache: () => config.embedder.precache,
  insertLog: defaultInsertLog,
  isCompiled: defaultIsCompiled
}

export type EmbedderState = 'ok' | 'starting' | 'failed' | 'stopped'

// biome-ignore lint/style/useConst: mutable for test injection of the deadline
export let EMBEDDER_START_TIMEOUT_MS = 300_000

export function sleepUnref(ms: number): Promise<void> {
  return new Promise<void>(r => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })
}

export class EmbedderSupervisor {
  protected proc: Subprocess | null = null
  protected ready = false
  protected dead = false
  protected shuttingDown = false
  protected generation = 0
  protected ipc = new IpcClient({
    getProc: () => this.proc,
    isAlive: () => !this.dead,
    onSendFailure: () => {
      this.dead = true
      this.ready = false
    }
  })
  protected readyPromise: Promise<void> | null = null
  protected readyResolve: (() => void) | null = null
  protected readyReject: ((err: Error) => void) | null = null

  protected startFailed = false
  protected backoffAttempt = 0
  protected cooldownUntil = 0
  protected ensureReadyPromise: Promise<void> | null = null

  constructor(protected deps: EmbedderClientDeps = DEFAULT_DEPS) {}

  isEmbedderReady(): boolean {
    return this.ready
  }

  getEmbedderState(): EmbedderState {
    // A first load that makes progress but exceeds EMBEDDER_START_TIMEOUT_MS is
    // latched as 'failed' (see runEnsureReady final cleanup) rather than
    // 'stopped', so /health surfaces the stall instead of a perpetual
    // 'starting'. A slow-but-successful load within the deadline returns 'ok'.
    if (this.ready) return 'ok'
    if (this.startFailed) return 'failed'
    return this.proc && !this.dead ? 'starting' : 'stopped'
  }

  protected getSpawnArgv(): string[] {
    const stub = process.env.SYNAPTOMIND_EMBEDDER_SCRIPT
    if (stub) return [process.execPath, 'run', stub]
    if (this.deps.isCompiled()) return [process.execPath, '--embedder']
    return [process.execPath, 'run', `${import.meta.dir}/embedder-process.ts`]
  }

  protected spawnProcess(): void {
    this.dead = false
    this.shuttingDown = false
    this.ready = false
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyPromise.catch(() => {})

    const generation = ++this.generation

    const child = spawn(this.getSpawnArgv(), {
      ipc: (message: IpcMessage) => {
        if (generation !== this.generation) return

        if (message.type === 'ready') {
          this.ready = true
          this.startFailed = false
          this.backoffAttempt = 0
          this.cooldownUntil = 0
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
            this.ipc.rejectAllPending(new EmbedderUnavailableError('Embedder process went idle'))
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

    void pipeChildStreams(child.stdout as unknown as ReadableStream<Uint8Array> | undefined, 'stdout', 'info', this.deps.insertLog)
    void pipeChildStreams(child.stderr as unknown as ReadableStream<Uint8Array> | undefined, 'stderr', 'warning', this.deps.insertLog)

    child.exited
      .then(code => {
        if (generation !== this.generation) return
        this.proc = null
        if (!this.dead && !this.shuttingDown) {
          console.error(`[embedder] process exited unexpectedly with code ${code}`)
          this.startFailed = true
        }
        if (!this.shuttingDown && !this.ready && this.readyReject) {
          this.readyReject(new Error(`Embedder process exited before becoming ready (code ${code})`))
          this.readyReject = null
        }
        this.dead = true
        this.ready = false
        if (!this.shuttingDown) {
          this.ipc.rejectAllPending(new EmbedderUnavailableError('Embedder process crashed'))
        }
      })
      .catch(() => {})
  }

  protected async ensureReady(): Promise<void> {
    if (this.ready) return
    if (!this.ensureReadyPromise) {
      const p = this.runEnsureReady().finally(() => {
        if (this.ensureReadyPromise === p) this.ensureReadyPromise = null
      })
      this.ensureReadyPromise = p
    }
    return this.ensureReadyPromise
  }

  protected async killCurrentChild(expectedGen?: number): Promise<void> {
    const p = this.proc
    if (!p) return
    if (expectedGen !== undefined && this.generation !== expectedGen) return
    this.generation++
    try {
      p.kill()
    } catch {}
    await Promise.race([this.waitForExit(p), sleepUnref(1000)])
  }

  protected startTimeoutMs(): number {
    const env = process.env.EMBEDDER_START_TIMEOUT_MS
    if (env) {
      const n = Number(env)
      if (Number.isFinite(n) && n > 0) return n
    }
    return EMBEDDER_START_TIMEOUT_MS
  }

  protected async runEnsureReady(): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs()
    while (Date.now() < deadline) {
      if (this.ready) return
      if (this.shuttingDown) {
        throw new EmbedderUnavailableError('Embedder shutting down')
      }
      if (this.startFailed && this.cooldownUntil > Date.now()) {
        const wait = this.cooldownUntil - Date.now()
        await sleepUnref(wait)
        continue
      }
      if (!this.proc || this.dead) {
        const ownedProc = this.proc
        const ownedGen = this.generation
        if (ownedProc) {
          await this.killCurrentChild(ownedGen)
        }
        if (this.shuttingDown) {
          throw new EmbedderUnavailableError('Embedder shutting down')
        }
        this.dead = false
        this.spawnProcess()
      }
      const ownedProc = this.proc
      const ownedGen = this.generation
      const p = this.readyPromise
      if (!p) continue
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new EmbedderNotReadyError('Embedder process failed to start within 5 min')),
          remaining
        )
        timer.unref?.()
      })
      try {
        await Promise.race([p, timeout])
        if (this.ready) return
      } catch {
        if (this.shuttingDown) {
          throw new EmbedderUnavailableError('Embedder shutting down')
        }
        if (
          !this.ready &&
          ownedProc !== null &&
          this.proc === ownedProc &&
          this.generation === ownedGen
        ) {
          await this.killCurrentChild(ownedGen)
          this.dead = true
          this.proc = null
          this.ready = false
          this.startFailed = true
          this.deps.insertLog('warning', 'embedder', 'Embedder child killed after failed start', {
            generation: ownedGen
          })
        }
        if (this.startFailed) {
          this.backoffAttempt += 1
          const delay = Math.min(1000 * 2 ** (this.backoffAttempt - 1), 30000)
          this.cooldownUntil = Date.now() + delay
          this.deps.insertLog('warning', 'embedder', 'Embedder start failed; backing off', {
            backoffAttempt: this.backoffAttempt,
            delayMs: delay
          })
        } else {
          await sleepUnref(1000)
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const ownedProc = this.proc
    const ownedGen = this.generation
    if (ownedProc && !this.ready && this.generation === ownedGen) {
      await this.killCurrentChild(ownedGen)
      this.proc = null
      this.dead = true
      this.ready = false
      this.startFailed = true
      this.deps.insertLog('error', 'embedder', 'Embedder failed to become ready within start timeout')
    }
    throw new EmbedderNotReadyError('Embedder process failed to start within 5 min')
  }

  protected async waitForExit(p: Subprocess): Promise<void> {
    try {
      await p.exited
    } catch {}
  }

  protected async teardownProcess(reason: string): Promise<void> {
    this.shuttingDown = true
    const readyPromise = this.ensureReadyPromise

    if (this.readyReject) {
      try {
        this.readyReject(new EmbedderUnavailableError(reason))
      } catch {}
      this.readyReject = null
      this.readyResolve = null
    }

    const proc = this.proc
    const gen = this.generation
    if (proc && this.generation === gen && this.proc === proc) {
      try {
        proc.send?.({ type: 'shutdown' })
      } catch {}
      await Promise.race([this.waitForExit(proc), sleepUnref(3000)])
      if (this.generation === gen && this.proc === proc) {
        await this.killCurrentChild(gen)
        this.deps.insertLog('info', 'embedder', 'Embedder child stopped during teardown', {
          generation: gen
        })
      }
    }

    if (readyPromise) {
      try {
        await readyPromise
      } catch {}
    }

    if (this.ensureReadyPromise === readyPromise) {
      this.ensureReadyPromise = null
    }
    if (this.proc === proc && (this.generation === gen || this.generation === gen + 1)) {
      this.proc = null
      this.ready = false
      this.dead = true
      this.startFailed = false
      this.backoffAttempt = 0
      this.cooldownUntil = 0
    }
    this.ipc.rejectAllPending(new EmbedderUnavailableError(reason))
    this.shuttingDown = false
  }
}

async function pipeChildStreams(
  stream: ReadableStream<Uint8Array> | undefined,
  streamName: 'stdout' | 'stderr',
  level: 'info' | 'warning' | 'error',
  insertLog: InsertLogFn
): Promise<void> {
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
        insertLog(level, 'embedder', `Embedder ${streamName} output`, { stream: streamName, output: trimmed })
      }
    }
    const tail = buf.trim()
    if (tail) insertLog(level, 'embedder', `Embedder ${streamName} output`, { stream: streamName, output: tail })
  } catch (err) {
    insertLog('error', 'embedder', `stdout/stderr reader failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}