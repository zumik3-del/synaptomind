import type { Subprocess } from 'bun'
import { EmbedderNotReadyError, EmbedderOverloadedError } from '../errors'

type EmbeddingPayload = number[] | number[][]

export interface IpcMessage {
  type: 'ready' | 'exiting' | 'result' | 'error' | 'request' | 'shutdown'
  id?: string
  error?: string
  embedding?: EmbeddingPayload
  method?: string
  params?: unknown
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const EMBEDDER_REQUEST_TIMEOUT_MS = 60_000
const MAX_PENDING = 256

/**
 * Lifecycle handles `EmbedderClient` exposes so the IPC bookkeeping can refuse
 * requests whose child is gone without owning the spawn/state machine.
 */
export interface IpcClientDeps {
  /** Current child process, or null between spawns. */
  getProc: () => Subprocess | null
  /** False once a crash or exit has latched the child as dead. */
  isAlive: () => boolean
  /** Latch the crash state (dead, not ready) when the IPC pipe send throws. */
  onSendFailure: () => void
}

/**
 * Client-side IPC bookkeeping for the embedder child: request ids, the pending
 * map, the per-request 60 s timeout, overload rejection (MAX_PENDING) and
 * result/error dispatch for incoming replies.
 */
export class IpcClient {
  private nextId = 1
  private pending = new Map<string, PendingRequest>()

  constructor(private deps: IpcClientDeps) {}

  sendRequest(method: string, params: unknown): Promise<unknown> {
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
      const proc = this.deps.getProc()
      if (!proc || !this.deps.isAlive()) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new EmbedderNotReadyError('Embedder process not available'))
        return
      }
      try {
        proc.send({ type: 'request', id, method, params })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        this.deps.onSendFailure()
        reject(new Error('Failed to send request to embedder process'))
      }
    })
  }

  rejectAllPending(err: Error): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer)
      req.reject(err)
      this.pending.delete(id)
    }
  }

  /** Deliver a child→parent result/error reply; other message types are ignored. */
  dispatch(message: IpcMessage): void {
    if (message.type !== 'result' && message.type !== 'error') return
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
  }
}
