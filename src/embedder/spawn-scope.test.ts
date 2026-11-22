import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import {
  EMBEDDER_BATCH_WORKER_ENV,
  EMBEDDER_USERS_ENV,
  batchWorkerEnabled,
  processOwnsBackgroundJobs,
  readEmbedderUsers
} from './spawn-scope'

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('processOwnsBackgroundJobs', () => {
  test('a plain process owns the background jobs', () => {
    expect(processOwnsBackgroundJobs([])).toBe(true)
    expect(processOwnsBackgroundJobs(['--http'])).toBe(true)
  })

  test('a stdio session delegates unless it is standalone', () => {
    expect(processOwnsBackgroundJobs(['--stdio'])).toBe(false)
    expect(processOwnsBackgroundJobs(['--stdio', '--stdio-standalone'])).toBe(true)
  })

  test('config.mcp.stdioStandalone keeps a stdio session local', () => {
    const standalone = config.mcp.stdioStandalone
    config.mcp.stdioStandalone = true
    try {
      expect(processOwnsBackgroundJobs(['--stdio'])).toBe(true)
    } finally {
      config.mcp.stdioStandalone = standalone
    }
  })
})

describe('readEmbedderUsers', () => {
  test('no list means the child falls back to config.users', () => {
    withEnv(EMBEDDER_USERS_ENV, undefined, () => {
      expect(readEmbedderUsers()).toBeNull()
    })
  })

  test('the assigned list is read verbatim', () => {
    const users = [{ id: 'beta', dbPath: '/tmp/beta.db' }]
    withEnv(EMBEDDER_USERS_ENV, JSON.stringify(users), () => {
      expect(readEmbedderUsers()).toEqual(users)
    })
  })

  test('entries without an id and a dbPath are dropped', () => {
    const raw = JSON.stringify([
      { id: 'beta', dbPath: '/tmp/beta.db' },
      { id: 'no-path' },
      { dbPath: '/tmp/no-id.db' },
      'not-an-entry'
    ])
    withEnv(EMBEDDER_USERS_ENV, raw, () => {
      expect(readEmbedderUsers()).toEqual([{ id: 'beta', dbPath: '/tmp/beta.db' }])
    })
  })

  test('a broken list falls back to config.users', () => {
    for (const raw of ['not json', '{"id":"beta"}', 'null']) {
      withEnv(EMBEDDER_USERS_ENV, raw, () => {
        expect(readEmbedderUsers()).toBeNull()
      })
    }
  })
})

describe('batchWorkerEnabled', () => {
  test('only the explicit false flag turns the worker off', () => {
    withEnv(EMBEDDER_BATCH_WORKER_ENV, undefined, () => {
      expect(batchWorkerEnabled()).toBe(true)
    })
    withEnv(EMBEDDER_BATCH_WORKER_ENV, 'false', () => {
      expect(batchWorkerEnabled()).toBe(false)
    })
    withEnv(EMBEDDER_BATCH_WORKER_ENV, 'true', () => {
      expect(batchWorkerEnabled()).toBe(true)
    })
  })
})
