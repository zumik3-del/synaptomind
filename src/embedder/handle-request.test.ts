import { describe, expect, test } from 'bun:test'
import { type EmbedderModel, handleEmbedderRequest, type EmbedderReply } from './handle-request'

/**
 * The model is INJECTED here instead of mocked through `mock.module('./model')`:
 * a static import of this handler no longer reaches `@huggingface/transformers`
 * (see the `EmbedderModel` doc comment), so the file costs milliseconds instead
 * of the ~2.5 s module load. The real wiring — handler + real model layer — is
 * exercised end to end by the embedder child-process suites.
 */
const calls: string[][] = []

const MODEL: EmbedderModel = {
  generateEmbedding: async text => {
    calls.push([text])
    if (text === '__fail__') throw new Error('model exploded')
    return new Float32Array([1, 2, 3])
  },
  generateEmbeddings: async texts => {
    calls.push(texts)
    return texts.map(() => new Float32Array([4, 5, 6]))
  }
}

function collect(): { replies: EmbedderReply[]; send: (reply: EmbedderReply) => void } {
  const replies: EmbedderReply[] = []
  return { replies, send: (reply: EmbedderReply) => replies.push(reply) }
}

describe('handleEmbedderRequest', () => {
  test("method 'embed' replies with a single result", async () => {
    calls.length = 0
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r1', method: 'embed', params: { text: 'hi' } }, send, MODEL)

    expect(replies).toEqual([{ type: 'result', id: 'r1', embedding: [1, 2, 3] }])
    expect(calls).toEqual([['hi']])
  })

  test("method 'embed_batch' replies with one vector per text", async () => {
    calls.length = 0
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r2', method: 'embed_batch', params: { texts: ['a', 'b'] } }, send, MODEL)

    expect(replies).toEqual([
      { type: 'result', id: 'r2', embedding: [[4, 5, 6], [4, 5, 6]] }
    ])
    // The batch reaches the model once, in order — not one call per text.
    expect(calls).toEqual([['a', 'b']])
  })

  test('unknown method replies with an error instead of hanging the client', async () => {
    calls.length = 0
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r3', method: 'embed_x' }, send, MODEL)

    // #113 regression guard: the client used to wait out its full 60s timeout.
    expect(replies).toEqual([
      { type: 'error', id: 'r3', error: 'Unknown embedder method: embed_x' }
    ])
    // An unknown method must not reach the model at all.
    expect(calls).toEqual([])
  })

  test('a thrown model error is reported as an error reply', async () => {
    const { replies, send } = collect()

    await handleEmbedderRequest({ id: 'r4', method: 'embed', params: { text: '__fail__' } }, send, MODEL)

    expect(replies).toEqual([{ type: 'error', id: 'r4', error: 'model exploded' }])
  })

  test("method 'embed' without params defaults text to '' and still replies", async () => {
    calls.length = 0
    const { replies, send } = collect()

    await handleEmbedderRequest({ method: 'embed' }, send, MODEL)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'result', embedding: [1, 2, 3] })
    expect(calls).toEqual([['']])
  })
})
