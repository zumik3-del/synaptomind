// Single source of truth for the embedder child↔parent IPC wire protocol.
//
// The child runs as a separate Bun process (ADR 0001) and the two sides talk
// over `process.send` / `process.on('message')` with structured-clone payloads.
// Every message shape lives here so the client (`ipc-client.ts`), the child-side
// handler (`handle-request.ts`) and the child entrypoint (`embedder-process.ts`)
// cannot drift apart. The wire format itself is unchanged by the extraction:
// requests are `{ type: 'request', id, method, params }` and replies
// `{ type: 'result' | 'error', id, ... }`.

/** Embedding payload on the wire: one vector, or one vector per input text. */
export type EmbeddingPayload = number[] | number[][]

/** Params of a client→child request; unknown methods carry no params at all. */
export interface EmbedderRequestParams {
  text?: string
  texts?: string[]
}

/**
 * Known embedder methods and the params each expects / reply each returns.
 * A method outside this map gets an error reply from the child instead of
 * leaving the client to wait out its full request timeout.
 */
export interface EmbedderMethodMap {
  embed: { params: { text?: string }; reply: number[] }
  embed_batch: { params: { texts?: string[] }; reply: number[][] }
}

/** A method name from `EmbedderMethodMap`; the child handles no other method. */
export type EmbedderMethod = keyof EmbedderMethodMap

/** Body of a client→child `request` (without the `type` discriminant). */
export interface EmbedderRequest {
  id?: string
  /** A known `EmbedderMethod`, or any other string the child rejects. */
  method?: string
  params?: EmbedderRequestParams
}

/** Child→client reply to a single request. */
export type EmbedderReply =
  | { type: 'result'; id?: string; embedding: EmbeddingPayload }
  | { type: 'error'; id?: string; error: string }

/** Child→client lifecycle notices. */
export type EmbedderLifecycle = { type: 'ready' } | { type: 'exiting' }

/** Client→child messages. */
export type IpcRequest = EmbedderRequest & { type: 'request' }
export type IpcShutdown = { type: 'shutdown' }

/** The full message union flowing over the pipe in either direction. */
export type IpcMessage = EmbedderLifecycle | EmbedderReply | IpcRequest | IpcShutdown
