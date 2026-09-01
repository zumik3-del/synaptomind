import { type Subprocess, spawn } from 'bun'
import { getEmbedderIdleTimeoutMs, getEmbedderPrecache } from '../db/settings'
import { insertLog } from '../logging'
import { EmbedderNotReadyError, EmbedderOverloadedError } from '../services/errors'

type EmbeddingPayload = number[] | number[][]

interface IpcMessage {
  type: 'ready' | 'exiting' | 'result' | 'error' | 'request' | 'shutdown'
  id?: string
  error?: string
  embedding?: EmbeddingPayload
  method?: string
  params?: unknown
}

let proc: Subprocess | null = null
let ready = false
export function isEmbedderReady(): boolean {
  return ready
}
export function isEmbedderDead(): boolean {
  return dead
}
let dead = false
let shuttingDown = false
let nextId = 1
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
let readyPromise: Promise<void> | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((err: Error) => void) | null = null

function getScriptPath(): string {
  return `${import.meta.dir}/embedder-process.ts`
}

function rejectAllPending(err: Error) {
  for (const [id, req] of pending) {
    req.reject(err)
    pending.delete(id)
  }
}

function spawnProcess(): void {
  dead = false
  shuttingDown = false
  ready = false
  readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // Suppress unhandled-rejection warnings when nobody is awaiting startup yet.
  readyPromise.catch(() => {})

  const child = spawn(['bun', 'run', getScriptPath()], {
    ipc: (message: IpcMessage) => {
      if (message.type === 'ready') {
        ready = true
        readyResolve?.()
        readyResolve = null
        return
      }

      if (message.type === 'exiting') {
        dead = true
        if (!ready && readyReject) {
          readyReject(new Error('Embedder process went idle before becoming ready'))
          readyReject = null
        }
        ready = false
        proc = null
        if (!shuttingDown) {
          rejectAllPending(new Error('Embedder process went idle'))
        }
        return
      }

      if (message.type === 'result' || message.type === 'error') {
        if (!message.id) return
        const req = pending.get(message.id)
        if (!req) return
        pending.delete(message.id)
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
      EMBEDDER_PRECACHE: getEmbedderPrecache() ? 'true' : 'false',
      EMBEDDER_IDLE_TIMEOUT: String(getEmbedderIdleTimeoutMs())
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })

  proc = child

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
          insertLog(level, 'embedder', `Embedder ${streamName} output`, { stream: streamName, output: trimmed })
        }
      }
      const tail = buf.trim()
      if (tail) insertLog(level, 'embedder', `Embedder ${streamName} output`, { stream: streamName, output: tail })
    } catch (err) {
      insertLog('error', 'embedder', `stdout/stderr reader failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  void pipeStream(child.stdout as unknown as ReadableStream<Uint8Array> | undefined, 'stdout', 'info')
  void pipeStream(child.stderr as unknown as ReadableStream<Uint8Array> | undefined, 'stderr', 'warning')

  child.exited
    .then(code => {
      if (proc === child) proc = null
      if (!dead && !shuttingDown) {
        console.error(`[embedder] process exited unexpectedly with code ${code}`)
      }
      if (!shuttingDown && !ready && readyReject) {
        readyReject(new Error(`Embedder process exited before becoming ready (code ${code})`))
        readyReject = null
      }
      dead = true
      ready = false
      if (!shuttingDown) {
        rejectAllPending(new Error('Embedder process crashed'))
      }
    })
    .catch(() => {})
}

const EMBEDDER_START_TIMEOUT_MS = 300_000

async function ensureReady(): Promise<void> {
  const deadline = Date.now() + EMBEDDER_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ready) return
    if (!proc || dead) spawnProcess()
    const p = readyPromise
    if (!p) continue
    const remaining = deadline - Date.now()
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new EmbedderNotReadyError('Embedder process failed to start within 5 min')), remaining)
    )
    try {
      await Promise.race([p, timeout])
      return
    } catch {
      if (!ready) {
        dead = true
        proc = null
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  throw new EmbedderNotReadyError('Embedder process failed to start within 5 min')
}

const EMBEDDER_REQUEST_TIMEOUT_MS = 60_000
const MAX_PENDING = 256

function sendRequest(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (pending.size >= MAX_PENDING) {
      reject(new EmbedderOverloadedError(`Embedder queue full (${pending.size}/${MAX_PENDING}); try again later`))
      return
    }
    const id = String(nextId++)
    pending.set(id, { resolve, reject })
    if (!proc || dead) {
      pending.delete(id)
      reject(new EmbedderNotReadyError('Embedder process not available'))
      return
    }
    try {
      proc.send({ type: 'request', id, method, params })

      setTimeout(() => {
        const req = pending.get(id)
        if (req) {
          pending.delete(id)
          req.reject(new Error('Embedder request timed out after 60s'))
        }
      }, EMBEDDER_REQUEST_TIMEOUT_MS)
    } catch {
      pending.delete(id)
      dead = true
      ready = false
      reject(new Error('Failed to send request to embedder process'))
    }
  })
}

export async function startEmbedderProcess(): Promise<void> {
  spawnProcess()
  await ensureReady()
  console.log('[embedder] child process started')
}

export async function stopEmbedderProcess(): Promise<void> {
  await teardownProcess('Embedder shutting down')
}

async function waitForExit(p: Subprocess): Promise<void> {
  try {
    await p.exited
  } catch {}
}

/** Shared teardown: graceful shutdown IPC, 3s exit race, kill, state reset. */
async function teardownProcess(reason: string): Promise<void> {
  shuttingDown = true
  if (proc) {
    try {
      proc.send?.({ type: 'shutdown' })
    } catch {}
    await Promise.race([waitForExit(proc), new Promise(r => setTimeout(r, 3000))])
    try {
      proc.kill()
    } catch {}
  }
  proc = null
  ready = false
  dead = true
  rejectAllPending(new Error(reason))
  shuttingDown = false
}

export async function restartEmbedder(): Promise<void> {
  await teardownProcess('Embedder restarting')
  spawnProcess()
  await ensureReady()
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  await ensureReady()
  return sendRequest('embed', { text }) as Promise<Float32Array>
}

export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  await ensureReady()
  return sendRequest('embed_batch', { texts }) as Promise<Float32Array[]>
}
