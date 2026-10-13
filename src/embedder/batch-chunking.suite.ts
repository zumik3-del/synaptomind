/**
 * IPC-boundary chunking suite for `EmbedderClient.generateEmbeddings`
 * (task #1567, AC9).
 *
 * The spy sits exactly on the IPC boundary: `ensureReady` (embedder lifecycle)
 * and `sendRequest` (the `embed_batch` JSON-RPC frame) are replaced on the
 * instance, so the assertions observe what would have crossed the pipe to the
 * child process — no real embedder, no subprocess, no model download.
 *
 * Runs in a child process (wrapper: `batch-chunking.test.ts`): other test files
 * mock.module('../embedder/client') globally and bun cannot unmock modules, so
 * this suite must not share a module registry with them.
 */
import { afterEach, expect, test } from 'bun:test'
import { EMBEDDER_BATCH_CHUNK, EmbedderClient } from './embedder-client'

interface IpcCall {
  method: string
  texts: string[]
}

const spiedClients: EmbedderClient[] = []

afterEach(() => {
  for (const client of spiedClients.splice(0)) {
    // Own-property shadows installed below; deleting them restores the prototype.
    delete (client as unknown as Record<string, unknown>).ensureReady
    delete (client as unknown as Record<string, unknown>).sendRequest
  }
})

/**
 * Fresh client whose two internals around the IPC boundary are stubbed.
 * `calls` records every `embed_batch` frame; the stub echoes each text as
 * `Float32Array([Number(text)])` so a vector identifies its own input text.
 */
function clientWithIpcSpy(): { client: EmbedderClient; calls: IpcCall[]; readyCalls: () => number } {
  const client = new EmbedderClient()
  const calls: IpcCall[] = []
  let readyCalls = 0

  const internals = client as unknown as {
    ensureReady: () => Promise<void>
    sendRequest: (method: string, params: { texts?: string[] }) => Promise<unknown>
  }

  internals.ensureReady = async () => {
    readyCalls++
  }
  internals.sendRequest = async (method, params) => {
    const texts = params.texts ?? []
    calls.push({ method, texts })
    if (method !== 'embed_batch') throw new Error(`unexpected IPC method ${method}`)
    return texts.map(text => new Float32Array([Number(text)]))
  }

  spiedClients.push(client)
  return { client, calls, readyCalls: () => readyCalls }
}

test('splits a batch larger than the chunk into ceil(N/chunk) IPC requests', async () => {
  const { client, calls } = clientWithIpcSpy()
  const texts = Array.from({ length: 150 }, (_, i) => String(i))

  const embeddings = await client.generateEmbeddings(texts)

  // The regression pin: pre-change the whole list travelled in ONE request.
  expect(calls).toHaveLength(3)
  const sizes = calls.map(c => c.texts.length)
  const chunk = Math.max(...sizes)
  expect(chunk).toBeLessThanOrEqual(EMBEDDER_BATCH_CHUNK)
  expect(calls).toHaveLength(Math.ceil(texts.length / chunk))
  // No single request may carry more than one chunk.
  expect(sizes.every(size => size <= chunk)).toBe(true)
  // Only the tail may be short.
  expect(sizes.slice(0, -1).every(size => size === chunk)).toBe(true)
  expect(calls.every(c => c.method === 'embed_batch')).toBe(true)

  // Every input text crossed the boundary exactly once, in input order.
  const sent = calls.flatMap(c => c.texts)
  expect(sent).toEqual(texts)

  // One vector per text, positionally aligned with the input.
  expect(embeddings).toHaveLength(texts.length)
  embeddings.forEach((vector, i) => {
    expect(vector).toBeInstanceOf(Float32Array)
    expect(Array.from(vector)).toEqual([i])
  })
})

test('a batch of exactly one chunk stays a single request, one more text adds a second', async () => {
  const short = clientWithIpcSpy()
  await short.client.generateEmbeddings(Array.from({ length: EMBEDDER_BATCH_CHUNK }, (_, i) => String(i)))
  expect(short.calls).toHaveLength(1)
  expect(short.calls[0]!.texts).toHaveLength(EMBEDDER_BATCH_CHUNK)

  const over = clientWithIpcSpy()
  await over.client.generateEmbeddings(Array.from({ length: EMBEDDER_BATCH_CHUNK + 1 }, (_, i) => String(i)))
  expect(over.calls).toHaveLength(2)
  expect(over.calls.map(c => c.texts.length)).toEqual([EMBEDDER_BATCH_CHUNK, 1])
})

test('an empty batch issues no IPC request and does not activate the embedder', async () => {
  const { client, calls, readyCalls } = clientWithIpcSpy()

  const embeddings = await client.generateEmbeddings([])

  expect(embeddings).toEqual([])
  expect(calls).toEqual([])
  expect(readyCalls()).toBe(0)
})

test('requests run sequentially: no request is sent before the embedder is ready', async () => {
  const { client, calls, readyCalls } = clientWithIpcSpy()

  await client.generateEmbeddings(['0', '1'])

  expect(readyCalls()).toBe(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.texts).toEqual(['0', '1'])
})
