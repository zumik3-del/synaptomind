import type { EmbedderReply, EmbedderRequest } from './ipc-protocol'

export type { EmbedderReply } from './ipc-protocol'

/**
 * The two model calls a request can need.
 *
 * Injected rather than imported at module scope on purpose: a static
 * `import './model'` drags `@huggingface/transformers` (plus onnxruntime) into
 * any process that merely imports this file — measured at ~2.5 s and a couple
 * hundred MB in the test run, paid by `handle-request.test.ts` for five
 * assertions that never touch a model. The production path is unchanged: the
 * real layer is resolved lazily on the first request that needs it.
 */
export interface EmbedderModel {
  generateEmbedding: (text: string) => Promise<Float32Array>
  generateEmbeddings: (texts: string[]) => Promise<Float32Array[]>
}

let realModel: Promise<EmbedderModel> | null = null

/** The production model layer, imported once on first use. */
function model(): Promise<EmbedderModel> {
  // A failed import must not wedge the process for good: drop the rejected
  // promise so the next request tries again (and reports its own error reply).
  realModel ??= import('./model').catch((err: unknown) => {
    realModel = null
    throw err
  })
  return realModel
}

// Handles one embedder IPC request and produces exactly one reply — unknown
// methods get an error reply instead of leaving the client waiting out its
// full request timeout.
export async function handleEmbedderRequest(
  message: EmbedderRequest,
  send: (reply: EmbedderReply) => void,
  embedder?: EmbedderModel
): Promise<void> {
  try {
    if (message.method === 'embed') {
      const { generateEmbedding } = embedder ?? (await model())
      const embedding = await generateEmbedding(message.params?.text ?? '')
      send({ type: 'result', id: message.id, embedding: Array.from(embedding) })
    } else if (message.method === 'embed_batch') {
      const { generateEmbeddings } = embedder ?? (await model())
      const embeddings = await generateEmbeddings(message.params?.texts ?? [])
      send({ type: 'result', id: message.id, embedding: embeddings.map(e => Array.from(e)) })
    } else {
      send({ type: 'error', id: message.id, error: `Unknown embedder method: ${String(message.method)}` })
    }
  } catch (err: unknown) {
    send({
      type: 'error',
      id: message.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
