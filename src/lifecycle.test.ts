import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { register } from './db'
import { createLifecycle, type LifecycleSteps } from './lifecycle'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

function recorded(calls: string[]): Partial<LifecycleSteps> {
  return {
    startEmbedder: () => calls.push('start-embedder'),
    stopEmbedder: async () => {
      calls.push('stop-embedder')
    },
    startBackgroundJobs: () => calls.push('start-jobs'),
    stopBackgroundJobs: async () => {
      calls.push('stop-jobs')
    },
    closeDatabases: () => calls.push('close-databases'),
    closeLogger: () => calls.push('close-logger')
  }
}

test('stop runs jobs, embedder, beforeExit, databases and the logger last', async () => {
  const calls: string[] = []
  const lifecycle = createLifecycle({
    ownsBackgroundJobs: true,
    embedderEnabled: true,
    log: () => {},
    steps: recorded(calls)
  })

  lifecycle.start()
  await lifecycle.stop(() => {
    calls.push('before-exit')
  })

  expect(calls).toEqual([
    'start-embedder',
    'start-jobs',
    'stop-jobs',
    'stop-embedder',
    'before-exit',
    'close-databases',
    'close-logger'
  ])
})

test('a delegated session starts neither the embedder nor the background jobs', () => {
  const calls: string[] = []
  const notices: string[] = []
  const lifecycle = createLifecycle({
    ownsBackgroundJobs: false,
    embedderEnabled: true,
    log: (_level, _type, message) => notices.push(message),
    steps: recorded(calls)
  })

  lifecycle.start()

  expect(calls).toEqual([])
  expect(notices.join(' ')).toContain('delegated')
})

test('a failing per-user close is logged with its userId and skips no later close', async () => {
  const calls: string[] = []
  register('bad', {
    close: () => {
      calls.push('close-bad')
      throw new Error('close boom')
    }
  } as unknown as Database)
  register('good', {
    close: () => {
      calls.push('close-good')
    }
  } as unknown as Database)

  const originalWrite = process.stderr.write
  let captured = ''
  process.stderr.write = ((chunk: string) => {
    captured += chunk
    return true
  }) as typeof process.stderr.write

  const lifecycle = createLifecycle({
    ownsBackgroundJobs: true,
    embedderEnabled: false,
    log: () => {},
    steps: {
      startEmbedder: () => {},
      stopEmbedder: async () => {},
      startBackgroundJobs: () => {},
      stopBackgroundJobs: async () => {},
      closeLogger: () => calls.push('close-logger')
    }
  })

  try {
    await lifecycle.stop()
  } finally {
    process.stderr.write = originalWrite
  }

  expect(calls).toEqual(['close-bad', 'close-good', 'close-logger'])
  expect(captured).toContain('Failed to close a user database')
  expect(captured).toContain('"userId":"bad"')
  expect(captured).toContain('close boom')
})

test('a throwing stopEmbedder is logged with its step and skips no later close', async () => {
  const calls: string[] = []
  const lifecycle = createLifecycle({
    ownsBackgroundJobs: true,
    embedderEnabled: true,
    log: (_level, _type, _message, metadata) => {
      if (metadata?.step) calls.push(`log:${String(metadata.step)}`)
    },
    steps: {
      ...recorded(calls),
      stopEmbedder: async () => {
        calls.push('stop-embedder')
        throw new Error('embedder boom')
      }
    }
  })

  lifecycle.start()
  const stopping = lifecycle.stop(() => {
    calls.push('before-exit')
  })

  await expect(stopping).rejects.toThrow('embedder boom')
  expect(calls).toEqual([
    'start-embedder',
    'start-jobs',
    'stop-jobs',
    'stop-embedder',
    'log:stopEmbedder',
    'before-exit',
    'close-databases',
    'close-logger'
  ])
})

test('src/index.ts does not re-derive the background-job ownership rule', () => {
  const index = source('./index.ts')
  expect(index).toContain('processOwnsBackgroundJobs()')
  expect(index).not.toContain('stdioStandalone')
  expect(index).not.toContain('ownsBackgroundJobs = !isStdio')
})
