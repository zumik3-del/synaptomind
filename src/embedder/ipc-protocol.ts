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
  | { type: 'error'; id?: string; error: string }

type EmbedderLifecycle = { type: 'ready' } | { type: 'exiting' }

type IpcRequest = EmbedderRequest & { type: 'request' }
type IpcShutdown = { type: 'shutdown' }

export type IpcMessage = EmbedderLifecycle | EmbedderReply | IpcRequest | IpcShutdown
