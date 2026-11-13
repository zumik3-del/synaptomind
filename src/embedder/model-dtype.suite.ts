/**
 * `config` is read at import time, so each dtype needs its own process; the
 * wrapper (`model-dtype.test.ts`) spawns this suite twice, once per dtype, and
 * the dtype under test arrives in `SYNAPTOMIND_EMBEDDER_DTYPE`.
 */
import { expect, mock, test } from 'bun:test'

interface PipelineCall {
  task: string
  model: string
  options: Record<string, unknown>
}

const pipelineCalls: PipelineCall[] = []
const extractorCalls: Array<{ text: string; options: Record<string, unknown> }> = []

const mockedEnv = {
  cacheDir: '',
  localModelPath: '',
  useBrowserCache: true,
  useFSCache: false
}

mock.module('@huggingface/transformers', () => ({
  env: mockedEnv,
  pipeline: async (task: string, model: string, options: Record<string, unknown>) => {
    pipelineCalls.push({ task, model, options })
    return async (text: string, callOptions: Record<string, unknown> = {}) => {
      extractorCalls.push({ text, options: callOptions })
      return { data: new Float32Array([0.5, 0.5]) }
    }
  }
}))

const { config } = await import('../config')
const { generateEmbedding, generateEmbeddings } = await import('./model')

test('the loader forwards config.embedder.dtype to pipeline(), not a literal', async () => {
  const requested = process.env.SYNAPTOMIND_EMBEDDER_DTYPE
  // The wrapper must drive this suite through the env var; a missing value
  // would make the assertion below vacuous.
  expect(requested === 'fp32' || requested === 'q8').toBe(true)

  const vector = await generateEmbedding('probe')

  expect(vector.length).toBe(2)
  expect(pipelineCalls).toHaveLength(1)
  const call = pipelineCalls[0]
  expect(call.task).toBe('feature-extraction')
  expect(call.model).toBe(config.embedder.model)
  // The regression pin: this is the value the loader picked, and it is BOTH the
  // requested dtype and whatever config resolved — no other source can supply it.
  expect(call.options.dtype).toBe(requested)
  expect(call.options.dtype).toBe(config.embedder.dtype)
  expect(call.options.cache_dir).toBe(config.embedder.cacheDir)
  // Single intra-op thread (the LXC pthread_setaffinity_np workaround) must survive.
  expect(call.options.session_options).toEqual({ intraOpNumThreads: 1 })
})

test('the e5 prefixes and pooling options are the ones the drift measurement assumed', async () => {
  extractorCalls.length = 0
  const loadsBefore = pipelineCalls.length

  await generateEmbedding('probe')
  await generateEmbeddings(['one', 'two'])

  expect(extractorCalls.map(c => c.text)).toEqual(['query: probe', 'passage: one', 'passage: two'])
  for (const call of extractorCalls) {
    expect(call.options.pooling).toBe('mean')
    expect(call.options.normalize).toBe(true)
  }
  expect(pipelineCalls.length).toBe(loadsBefore)

  // model.ts re-points the transformers cache at the configured directory
  // (v4.2.0 drops cache_dir while resolving internal file lists).
  expect(mockedEnv.cacheDir).toBe(config.embedder.cacheDir)
  expect(mockedEnv.localModelPath).toBe(config.embedder.cacheDir)
  expect(mockedEnv.useFSCache).toBe(true)
  expect(mockedEnv.useBrowserCache).toBe(false)
})
