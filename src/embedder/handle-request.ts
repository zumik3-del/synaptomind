import { generateEmbedding, generateEmbeddings } from './model'

export interface EmbedderRequest {
  id?: string
  method?: string
  params?: { text?: string; texts?: string[] }
}

export type EmbedderReply = { type: 'result'; id?: string; embedding: number[] | number[][] } | {
  type: 'error'
  id?: string
  error: string
}

// Handles one embedder IPC request and produces exactly one reply — unknown
// methods get an error reply instead of leaving the client waiting out its
// full request timeout.
export async function handleEmbedderRequest(
  message: EmbedderRequest,
  send: (reply: EmbedderReply) => void
): Promise<void> {
  try {
    if (message.method === 'embed') {
      const embedding = await generateEmbedding(message.params?.text ?? '')
      send({ type: 'result', id: message.id, embedding: Array.from(embedding) })
    } else if (message.method === 'embed_batch') {
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
