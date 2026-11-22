import type { EmbedderErrorCode } from './ipc-error-codes'

export const EMBEDDER_IPC_PROTOCOL_VERSION = 1

type EmbeddingPayload = number[] | number[][]

interface EmbedderRequestParams {
  text?: string
  texts?: string[]
}

export interface EmbedderRequest {
  id?: string
  method?: string
  params?: EmbedderRequestParams
}

export type EmbedderReply =
  | { type: 'result'; id?: string; embedding: EmbeddingPayload }
  | { type: 'error'; id?: string; error: string; code?: EmbedderErrorCode }

type EmbedderLifecycle = { type: 'ready'; protocol: number } | { type: 'exiting' }

type IpcRequest = EmbedderRequest & { type: 'request' }
type IpcShutdown = { type: 'shutdown' }

export type IpcMessage = EmbedderLifecycle | EmbedderReply | IpcRequest | IpcShutdown
