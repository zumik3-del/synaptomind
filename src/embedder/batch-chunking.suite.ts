import { afterEach, expect, test } from 'bun:test'
import { EMBEDDER_BATCH_CHUNK, EmbedderClient } from './embedder-client'

interface IpcCall {
  method: string
  texts: string[]
}

const spiedClients: EmbedderClient[] = []

afterEach(() => {
  for (const client of spiedClients.splice(0)) {
    delete (client as unknown as Record<string, unknown>).ensureReady
    delete (client as unknown as Record<string, unknown>).sendRequest
  }
})

function clientWithIpcSpy(): {
  client: EmbedderClient
  calls: IpcCall[]
  readyCalls: () => number
} {
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

  expect(calls).toHaveLength(3)
  const sizes = calls.map(c => c.texts.length)
  const chunk = Math.max(...sizes)
  expect(chunk).toBeLessThanOrEqual(EMBEDDER_BATCH_CHUNK)
  expect(calls).toHaveLength(Math.ceil(texts.length / chunk))
  expect(sizes.every(size => size <= chunk)).toBe(true)
  expect(sizes.slice(0, -1).every(size => size === chunk)).toBe(true)
  expect(calls.every(c => c.method === 'embed_batch')).toBe(true)

  const sent = calls.flatMap(c => c.texts)
  expect(sent).toEqual(texts)

  expect(embeddings).toHaveLength(texts.length)
  embeddings.forEach((vector, i) => {
    expect(vector).toBeInstanceOf(Float32Array)
    expect(Array.from(vector)).toEqual([i])
  })
})

test('a batch of exactly one chunk stays a single request, one more text adds a second', async () => {
  const short = clientWithIpcSpy()
  await short.client.generateEmbeddings(
    Array.from({ length: EMBEDDER_BATCH_CHUNK }, (_, i) => String(i))
  )
  expect(short.calls).toHaveLength(1)
  expect(short.calls[0]!.texts).toHaveLength(EMBEDDER_BATCH_CHUNK)

  const over = clientWithIpcSpy()
  await over.client.generateEmbeddings(
    Array.from({ length: EMBEDDER_BATCH_CHUNK + 1 }, (_, i) => String(i))
  )
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
