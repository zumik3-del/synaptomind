import type { EmbedderReply, EmbedderRequest } from './ipc-protocol'

export type { EmbedderReply } from './ipc-protocol'

export interface EmbedderModel {
  generateEmbedding: (text: string) => Promise<Float32Array>
  generateEmbeddings: (texts: string[]) => Promise<Float32Array[]>
}

let realModel: Promise<EmbedderModel> | null = null

function model(): Promise<EmbedderModel> {
  realModel ??= import('./model').catch((err: unknown) => {
    realModel = null
    throw err
  })
  return realModel
}

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
      send({
        type: 'error',
        id: message.id,
        error: `Unknown embedder method: ${String(message.method)}`
      })
    }
  } catch (err: unknown) {
    send({
      type: 'error',
      id: message.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
