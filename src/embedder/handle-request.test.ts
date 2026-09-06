import { describe, expect, mock, test } from 'bun:test'
import { handleEmbedderRequest, type EmbedderReply } from './handle-request'

// Mock the model layer so no real pipeline is loaded. The specifier matches
// handle-request.ts's own import ('./model') — same directory, same module.
mock.module('./model', () => ({
  generateEmbedding: async (text: string) => {
    if (text === '__fail__') throw new Error('model exploded')
    return new Float32Array([1, 2, 3])
  },
  generateEmbeddings: async (texts: string[]) => texts.map(() => new Float32Array([4, 5, 6]))
}))

function collect(): { replies: EmbedderReply[]; send: (reply: EmbedderReply) => void } {
  const replies: EmbedderReply[] = []
  return { replies, send: (reply: EmbedderReply) => replies.push(reply) }
}

describe('handleEmbedderRequest', () => {
  test("method 'embed' replies with a single result", async () => {
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r1', method: 'embed', params: { text: 'hi' } }, send)

    expect(replies).toEqual([{ type: 'result', id: 'r1', embedding: [1, 2, 3] }])
  })

  test("method 'embed_batch' replies with one vector per text", async () => {
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r2', method: 'embed_batch', params: { texts: ['a', 'b'] } }, send)

    expect(replies).toEqual([{ type: 'result', id: 'r2', embedding: [[4, 5, 6], [4, 5, 6]] }])
  })

  test('unknown method replies with an error instead of hanging the client', async () => {
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r3', method: 'embed_x' }, send)

    // #113 regression guard: the client used to wait out its full 60s timeout.
    expect(replies).toEqual([
      { type: 'error', id: 'r3', error: 'Unknown embedder method: embed_x' }
    ])
  })

  test('a thrown model error is reported as an error reply', async () => {
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r4', method: 'embed', params: { text: '__fail__' } }, send)

    expect(replies).toEqual([{ type: 'error', id: 'r4', error: 'model exploded' }])
  })

  test("method 'embed' without params defaults text to '' and still replies", async () => {
    const { replies, send } = collect()

    await handleEmbedderRequest({ method: 'embed' }, send)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'result', embedding: [1, 2, 3] })
  })
})
