import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb, seedThought } from '../test/helpers'
import { config } from '../config'
import { searchThoughtsOutcome } from '../services/search.service'
import { closeDb } from '../db/init'
import { clearUnavailable, markUnavailable } from '../context/registry'
import { EmbedderNotReadyError, EmbedderUnavailableError } from '../errors'
import { EmbedderClient } from './embedder-client'
import { getHealthService } from '../services/health.service'
import {
  generateEmbedding,
  generateEmbeddings,
  getEmbedderState,
  isEmbedderReady,
  startEmbedderProcess,
  stopEmbedderProcess
} from './client-core'

// Import the implementation directly via client-core: other test files
// mock.module('../embedder/client') globally (bun cannot unmock modules),
// so this suite must not resolve that specifier.
//
// The client keeps global state (proc/ready/dead/pending), so this file runs
// strictly sequentially: every test starts from a stopped client and stops it
// again in afterEach.
const STUB_PATH = `${import.meta.dir}/__fixtures__/stub-embedder.ts`
const LIFECYCLE_STUB_PATH = `${import.meta.dir}/__fixtures__/stub-embedder-lifecycle.ts`
const ENV_STUB_PATH = `${import.meta.dir}/__fixtures__/stub-embedder-env.ts`
const PROTOCOL_STUB_PATH = `${import.meta.dir}/__fixtures__/stub-embedder-protocol.ts`

const scratchDirs: string[] = []

beforeAll(() => {
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = STUB_PATH
})

afterAll(() => {
  delete process.env.SYNAPTOMIND_EMBEDDER_SCRIPT
})

beforeEach(createTestDb)

afterEach(async () => {
  await stopEmbedderProcess()
  closeDb()
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = STUB_PATH
  delete process.env.SYNAPTOMIND_STUB_MODE
  delete process.env.SYNAPTOMIND_STUB_HANG_MS
  delete process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE
  delete process.env.SYNAPTOMIND_STUB_REQUEST_FILE
  delete process.env.SYNAPTOMIND_STUB_EXIT_FILE
  delete process.env.SYNAPTOMIND_STUB_ENV_FILE
  delete process.env.SYNAPTOMIND_STUB_PROTOCOL
  delete process.env.EMBEDDER_BACKOFF_BASE_MS
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function shrinkBackoff(baseMs = 25): void {
  process.env.EMBEDDER_BACKOFF_BASE_MS = String(baseMs)
}

function useLifecycleStub(
  mode:
    | 'hang'
    | 'crash-then-recover'
    | 'ready-no-answer'
    | 'idle-exit-on-request'
    | 'idle-exit-no-msg'
    | 'crash-on-request'
    | 'idle-exit-once',
  hangMs?: number
) {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-embedder-'))
  scratchDirs.push(dir)
  const counter = join(dir, 'attempts')
  const requestFile = join(dir, 'request')
  const exitFile = join(dir, 'exited')
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = LIFECYCLE_STUB_PATH
  process.env.SYNAPTOMIND_STUB_MODE = mode
  if (hangMs !== undefined) process.env.SYNAPTOMIND_STUB_HANG_MS = String(hangMs)
  process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE = counter
  process.env.SYNAPTOMIND_STUB_REQUEST_FILE = requestFile
  process.env.SYNAPTOMIND_STUB_EXIT_FILE = exitFile
  return {
    attempts: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0),
    requestSeen: () => existsSync(requestFile),
    exited: () => existsSync(exitFile)
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`)
}

function readChildEnv(file: string): Record<string, string | null> {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function envStubScratch(): { envFile: string; attempts: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-embedder-'))
  scratchDirs.push(dir)
  const envFile = join(dir, 'env.json')
  const attemptFile = join(dir, 'attempts')
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = ENV_STUB_PATH
  process.env.SYNAPTOMIND_STUB_ENV_FILE = envFile
  process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE = attemptFile
  return {
    envFile,
    attempts: () => (existsSync(attemptFile) ? Number(readFileSync(attemptFile, 'utf8').trim()) : 0)
  }
}

function protocolStub(protocol: 'absent' | number): { attempts: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-embedder-'))
  scratchDirs.push(dir)
  const counter = join(dir, 'attempts')
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = PROTOCOL_STUB_PATH
  process.env.SYNAPTOMIND_STUB_PROTOCOL = String(protocol)
  process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE = counter
  return {
    attempts: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0)
  }
}

test('startEmbedderProcess becomes ready against the stub subprocess', async () => {
  expect(isEmbedderReady()).toBe(false)

  await startEmbedderProcess()

  expect(isEmbedderReady()).toBe(true)
})

test('injected deps reach the spawned child as SYNAPTOMIND_ env values', async () => {
  const { envFile } = envStubScratch()
  const client = new EmbedderClient({
    getEmbedderPrecache: () => true,
    getEmbedderIdleTimeoutMs: () => 0,
    insertLog: () => {},
    isCompiled: () => false
  })
  try {
    await client.startEmbedderProcess()
    const env = readChildEnv(envFile)
    expect(env.precache).toBe('true')
    expect(env.idleTimeoutMs).toBe('0')
  } finally {
    await client.stopEmbedderProcess()
    delete process.env.SYNAPTOMIND_STUB_ENV_FILE
  }
})

test('default deps forward the configured precache and idle timeout to the child', async () => {
  const { envFile } = envStubScratch()
  const precache = config.embedder.precache
  const idleTimeoutMs = config.embedder.idleTimeoutMs
  config.embedder.precache = true
  config.embedder.idleTimeoutMs = 42_000
  const client = new EmbedderClient()
  try {
    await client.startEmbedderProcess()
    const env = readChildEnv(envFile)
    expect(env.precache).toBe('true')
    expect(env.idleTimeoutMs).toBe('42000')
  } finally {
    config.embedder.precache = precache
    config.embedder.idleTimeoutMs = idleTimeoutMs
    await client.stopEmbedderProcess()
    delete process.env.SYNAPTOMIND_STUB_ENV_FILE
  }
})

class RegressionClient extends EmbedderClient {
  spawns = 0
  protected override spawnProcess(): void {
    this.spawns++
    throw new Error('unexpected spawn')
  }
  protected override async ensureReady(): Promise<void> {
    if (!process.env.SYNAPTOMIND_TEST_OLD_ENSURE_READY) return super.ensureReady()
    if (this.ready) return
    if (!this.ensureReadyPromise) {
      const p = this.runEnsureReady().finally(() => {
        if (this.ensureReadyPromise === p) this.ensureReadyPromise = null
      })
      this.ensureReadyPromise = p
    }
    return this.ensureReadyPromise
  }
}

for (const disabledBy of ['config', 'flag'] as const) {
  test(`${disabledBy} disables explicit and on-demand embedder starts with BM25 fallback`, async () => {
    const enabled = config.embedder.enabled
    const argv = [...process.argv]
    const client = new RegressionClient()
    const stub = useLifecycleStub('ready-no-answer')
    try {
      config.embedder.enabled = disabledBy !== 'config'
      if (disabledBy === 'flag') process.argv.push('--no-embedder')
      for (const call of [
        () => client.startEmbedderProcess(),
        () => client.generateEmbedding('hello'),
        () => client.generateEmbeddings(['hello', 'world'])
      ]) {
        await expect(call()).rejects.toBeInstanceOf(EmbedderUnavailableError)
      }
      expect(client.spawns).toBe(0)
      expect(client.isEmbedderReady()).toBe(false)
      const id = seedThought({ content: 'quartzbadger unique searchable phrase' })
      const outcome = await searchThoughtsOutcome({ query: 'quartzbadger', hybrid: true })
      expect(outcome.items.map(item => item.thought.id)).toContain(id)
      expect(outcome.items[0]?.degraded).toBe(true)
      expect(isEmbedderReady()).toBe(false)
      expect(stub.attempts()).toBe(0)
    } finally {
      config.embedder.enabled = enabled
      process.argv.splice(0, process.argv.length, ...argv)
      await client.stopEmbedderProcess()
    }
  })
}

test('enabled client starts lazily for a first single request', async () => {
  expect(isEmbedderReady()).toBe(false)
  expect(Array.from(await generateEmbedding('hello'))).toEqual([5, 1, 2])
  expect(isEmbedderReady()).toBe(true)
})

test('generateEmbedding round-trips through the stub IPC protocol', async () => {
  await startEmbedderProcess()

  const embedding = await generateEmbedding('hello')

  expect(embedding).toBeInstanceOf(Float32Array)
  expect(Array.from(embedding)).toEqual([5, 1, 2])
})

test('generateEmbeddings returns one vector per text', async () => {
  await startEmbedderProcess()

  const embeddings = await generateEmbeddings(['ab', 'abcd'])

  expect(embeddings).toHaveLength(2)
  expect(Array.from(embeddings[0]!)).toEqual([2, 1, 2])
  expect(Array.from(embeddings[1]!)).toEqual([4, 1, 2])
})

test('an error reply from the subprocess rejects the request', async () => {
  await startEmbedderProcess()

  expect(generateEmbedding('__fail__')).rejects.toThrow('stub failure')
})

test('stopEmbedderProcess marks the client dead; the next request respawns it', async () => {
  await startEmbedderProcess()

  await stopEmbedderProcess()

  expect(isEmbedderReady()).toBe(false)

  const embedding = await generateEmbedding('hello')
  expect(Array.from(embedding)).toEqual([5, 1, 2])
  expect(isEmbedderReady()).toBe(true)
})

test("getEmbedderState is 'stopped' before any spawn and 'ok' once the child reports ready", async () => {
  expect(getEmbedderState()).toBe('stopped')
  expect(getHealthService().checks.embedder).toBe('not ready')

  await startEmbedderProcess()

  expect(getEmbedderState()).toBe('ok')
  expect(getHealthService().checks.embedder).toBe('ok')
})

test("getEmbedderState stays 'starting' while the child is alive but has not reported ready", async () => {
  const stub = useLifecycleStub('hang')
  const started = startEmbedderProcess()
  started.catch(() => {})

  await waitFor(() => stub.attempts() >= 1, 'the stub child to spawn')

  expect(getEmbedderState()).toBe('starting')
  expect(getHealthService().checks.embedder).toBe('not ready')
})

test('a crashed child latches getEmbedderState as failed until a real ready clears it', async () => {
  shrinkBackoff()
  const stub = useLifecycleStub('crash-then-recover', 300)

  const started = startEmbedderProcess()

  await waitFor(() => getEmbedderState() === 'failed', "getEmbedderState to latch 'failed'")
  expect(getHealthService().checks.embedder).toBe('failed')

  await waitFor(() => stub.attempts() >= 2, 'the retry attempt to spawn')
  expect(getEmbedderState()).toBe('failed')

  await started
  expect(getEmbedderState()).toBe('ok')
  expect(getHealthService().checks.embedder).toBe('ok')
}, 30_000)

test('a deliberate teardown leaves the state stopped instead of latching failed', async () => {
  await startEmbedderProcess()
  expect(getEmbedderState()).toBe('ok')

  await stopEmbedderProcess()

  expect(getEmbedderState()).toBe('stopped')
  expect(getHealthService().checks.embedder).toBe('not ready')
})

test('an idle unload rejects an in-flight request with EmbedderUnavailableError (503)', async () => {
  useLifecycleStub('idle-exit-on-request')
  const client = new EmbedderClient()
  await client.startEmbedderProcess()

  const err: unknown = await client.generateEmbedding('hello').catch(e => e)

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder process went idle')
}, 15_000)

test('a crashed child rejects an in-flight request with EmbedderUnavailableError (503)', async () => {
  useLifecycleStub('crash-on-request')
  const client = new EmbedderClient()
  await client.startEmbedderProcess()

  const err: unknown = await client.generateEmbedding('hello').catch(e => e)

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder process crashed')
}, 15_000)

test('a deliberate teardown rejects an in-flight request with EmbedderUnavailableError (503)', async () => {
  const stub = useLifecycleStub('ready-no-answer')
  const client = new EmbedderClient()
  await client.startEmbedderProcess()

  const pending = client.generateEmbedding('hello').catch(e => e)
  await waitFor(() => stub.requestSeen(), 'the stub to receive the request')
  await client.stopEmbedderProcess()

  const err: unknown = await pending

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder shutting down')
}, 15_000)

test('a superseded idle-exit child cannot clobber its respawned successor (#1784)', async () => {
  const stub = useLifecycleStub('idle-exit-once', 500)
  const client = new EmbedderClient()
  await client.startEmbedderProcess()
  expect(client.getEmbedderState()).toBe('ok')

  const err: unknown = await client.generateEmbedding('hello').catch(e => e)
  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder process went idle')

  const vector = await client.generateEmbedding('hello')
  expect(Array.from(vector)).toEqual([5, 1, 2])

  await waitFor(() => stub.exited(), 'the superseded child to exit')
  await new Promise(r => setTimeout(r, 50))

  expect(client.getEmbedderState()).toBe('ok')
  expect(Array.from(await client.generateEmbedding('hello'))).toEqual([5, 1, 2])

  await client.stopEmbedderProcess()
}, 20_000)

test('a clean exit without the exiting message leaves the state stopped', async () => {
  const stub = useLifecycleStub('idle-exit-no-msg')
  await startEmbedderProcess()
  expect(getEmbedderState()).toBe('ok')

  const err: unknown = await generateEmbedding('hello').catch(e => e)

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder process exited')
  expect(stub.exited()).toBe(true)
  expect(getEmbedderState()).toBe('stopped')
  expect(getHealthService().checks.embedder).toBe('not ready')

  const vector = await generateEmbedding('hello')
  expect(Array.from(vector)).toEqual([5, 1, 2])
  expect(stub.attempts()).toBe(2)
  expect(getEmbedderState()).toBe('ok')
}, 15_000)

test('a non-zero exit still latches the state as failed', async () => {
  useLifecycleStub('crash-on-request')
  await startEmbedderProcess()
  expect(getEmbedderState()).toBe('ok')

  const err: unknown = await generateEmbedding('hello').catch(e => e)

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder process crashed')
  expect(getEmbedderState()).toBe('failed')
  expect(getHealthService().checks.embedder).toBe('failed')
}, 15_000)

test('second concurrent ensureReady() reuses the same promise (single-flight)', async () => {
  const client = new EmbedderClient()
  const internals = client as unknown as {
    ready: boolean
    ensureReady: () => Promise<void>
    runEnsureReady: () => Promise<void>
  }
  let runs = 0
  internals.runEnsureReady = async () => {
    runs++
    await new Promise(r => setTimeout(r, 50))
    ;(client as unknown as { ready: boolean }).ready = true
  }

  const p1 = internals.ensureReady()
  const p2 = internals.ensureReady()
  await Promise.all([p1, p2])
  expect(runs).toBe(1)
  expect((client as unknown as { ready: boolean }).ready).toBe(true)
})

test('startFailed latches backoffAttempt and a cooldown window before respawn', async () => {
  shrinkBackoff()
  useLifecycleStub('crash-then-recover', 300)
  const client = new EmbedderClient()
  const started = client.startEmbedderProcess()
  started.catch(() => {})

  await waitFor(() => {
    const internals = client as unknown as { startFailed: boolean }
    return internals.startFailed === true
  }, 'startFailed to latch')

  const internals = client as unknown as {
    startFailed: boolean
    backoffAttempt: number
    cooldownUntil: number
  }
  expect(internals.startFailed).toBe(true)
  expect(internals.backoffAttempt).toBeGreaterThanOrEqual(1)
  expect(internals.cooldownUntil).toBeGreaterThan(0)

  await started.catch(() => {})
  await client.stopEmbedderProcess().catch(() => {})
}, 30_000)

test('killCurrentChild bumps the generation so a killed child cannot clobber a successor', async () => {
  const c = new EmbedderClient()
  await c.startEmbedderProcess()
  const ci = c as unknown as { generation: number; proc: unknown }
  const genBefore = ci.generation
  expect(ci.proc).not.toBeNull()
  await (c as unknown as { killCurrentChild: () => Promise<void> }).killCurrentChild()
  expect(ci.generation).toBe(genBefore + 1)
  await c.stopEmbedderProcess().catch(() => {})
})

test('generateEmbeddings chunks the batch and returns N vectors in input order', async () => {
  await startEmbedderProcess()

  const texts = Array.from({ length: 200 }, (_, i) => 'x'.repeat(i + 1))

  const embeddings = await generateEmbeddings(texts)

  expect(embeddings).toHaveLength(texts.length)
  embeddings.forEach((vector, i) => {
    expect(Array.from(vector)).toEqual([texts[i]!.length, 1, 2])
  })
})

test('real deadline path latches failed state with injected EMBEDDER_START_TIMEOUT_MS', async () => {
  process.env.EMBEDDER_START_TIMEOUT_MS = '200'
  useLifecycleStub('hang')
  const client = new EmbedderClient()
  const started = client.startEmbedderProcess()
  await expect(started).rejects.toThrow(/failed to start within/i)
  expect(client.getEmbedderState()).toBe('failed')
  await client.stopEmbedderProcess().catch(() => {})
  delete process.env.EMBEDDER_START_TIMEOUT_MS
}, 10_000)

test('teardown does not kill a newer live child', async () => {
  const client = new EmbedderClient()
  await client.startEmbedderProcess()
  const internals = client as unknown as {
    proc: unknown
    generation: number
    shuttingDown: boolean
    spawnProcess: () => void
    waitForExit: (p: unknown) => Promise<void>
  }
  const origWaitForExit = internals.waitForExit.bind(internals)
  internals.waitForExit = (p: unknown) =>
    new Promise<void>(resolve => {
      setTimeout(() => {
        void origWaitForExit(p).then(resolve)
      }, 200)
    })

  const teardownPromise = client.stopEmbedderProcess()
  await new Promise(r => setTimeout(r, 50))
  internals.shuttingDown = false
  internals.spawnProcess()
  await new Promise(r => setTimeout(r, 50))
  const newProc = internals.proc
  await teardownPromise

  expect(newProc).not.toBeNull()
  await waitFor(() => client.getEmbedderState() === 'ok', 'the successor to report ready')
  await client.stopEmbedderProcess().catch(() => {})
}, 15_000)

test('cooldown branch is reachable and waits before respawn', async () => {
  shrinkBackoff(300)
  const stub = useLifecycleStub('crash-then-recover', 300)
  const client = new EmbedderClient()
  const started = client.startEmbedderProcess()
  started.catch(() => {})

  const internals = client as unknown as { backoffAttempt: number; cooldownUntil: number }
  await waitFor(() => internals.cooldownUntil > Date.now(), 'cooldownUntil to be set in the future')

  expect(internals.backoffAttempt).toBeGreaterThanOrEqual(1)

  const attemptsAtLatch = stub.attempts()
  const remaining = internals.cooldownUntil - Date.now()
  await new Promise(r => setTimeout(r, Math.max(0, Math.floor(remaining / 2))))
  expect(stub.attempts()).toBe(attemptsAtLatch)

  await client.stopEmbedderProcess().catch(() => {})
  await started.catch(() => {})
}, 30_000)

test('a coded error reply surfaces as its typed class with the 503 statusCode', async () => {
  await startEmbedderProcess()

  const err: unknown = await generateEmbedding('__typed__').catch(e => e)

  expect(err).toBeInstanceOf(EmbedderNotReadyError)
  expect((err as EmbedderNotReadyError).statusCode).toBe(503)
  expect((err as Error).message).toBe('stub failure: model is loading')
})

test('an empty payload from the child rejects instead of resolving a zero-length vector', async () => {
  await startEmbedderProcess()

  const err: unknown = await generateEmbedding('__empty__').catch(e => e)

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as Error).message).toBe('Embedder returned an empty embedding payload')
})

test('a short batch reply is passed through unpadded: the client does not verify the vector count', async () => {
  await startEmbedderProcess()

  const vectors = await generateEmbeddings(['__short__', 'b'])

  expect(vectors).toHaveLength(1)
  expect(Array.from(vectors[0]!)).toEqual([1, 1, 2])
})

for (const protocol of ['absent', 2] as const) {
  const got = protocol === 'absent' ? 'undefined' : String(protocol)
  test(`a ready with ${protocol === 'absent' ? 'no protocol' : `protocol ${protocol}`} fails fast: one spawn, latched failure, EmbedderNotReadyError`, async () => {
    const stub = protocolStub(protocol)
    const client = new EmbedderClient()
    try {
      const first: unknown = await client.startEmbedderProcess().catch(e => e)
      expect(first).toBeInstanceOf(EmbedderNotReadyError)
      expect((first as Error).message).toBe(
        `Embedder IPC protocol mismatch: expected 1, got ${got}`
      )
      expect(client.getEmbedderState()).toBe('failed')

      const second: unknown = await client.startEmbedderProcess().catch(e => e)
      expect(second).toBeInstanceOf(EmbedderNotReadyError)
      expect(stub.attempts()).toBe(1)

      await client.stopEmbedderProcess()
      expect(client.getEmbedderState()).toBe('stopped')

      process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = STUB_PATH
      await client.startEmbedderProcess()
      expect(client.getEmbedderState()).toBe('ok')
      expect(stub.attempts()).toBe(1)
    } finally {
      await client.stopEmbedderProcess().catch(() => {})
    }
  }, 15_000)
}

test('the child receives the configured users minus the ones boot fan-out marked unavailable', async () => {
  const users = config.users
  config.users = [
    { id: 'alpha', dbPath: '/tmp/alpha.db', tokenSha256: '0'.repeat(64) },
    { id: 'beta', dbPath: '/tmp/beta.db', tokenSha256: '1'.repeat(64) }
  ]
  markUnavailable('alpha', new Error('unreadable'))
  const { envFile } = envStubScratch()
  const client = new EmbedderClient()
  try {
    await client.startEmbedderProcess()

    const env = readChildEnv(envFile)
    const assigned = JSON.parse(env.users ?? 'null') as unknown[]
    expect(assigned).toEqual([{ id: 'beta', dbPath: '/tmp/beta.db' }])
    expect(Object.keys(assigned[0] as object).sort()).toEqual(['dbPath', 'id'])
    expect(env.batchWorker).toBeNull()
  } finally {
    clearUnavailable()
    config.users = users
    await client.stopEmbedderProcess().catch(() => {})
    delete process.env.SYNAPTOMIND_STUB_ENV_FILE
  }
})

test('a delegating stdio session spawns nothing until a request, then flags its child as on-demand only', async () => {
  const argv = [...process.argv]
  const stdioStandalone = config.mcp.stdioStandalone
  process.argv.push('--stdio')
  config.mcp.stdioStandalone = false
  const { envFile, attempts } = envStubScratch()
  const client = new EmbedderClient()
  try {
    expect(client.getEmbedderState()).toBe('stopped')
    expect(attempts()).toBe(0)

    const vector = await client.generateEmbedding('hello')

    expect(Array.from(vector)).toEqual([5, 1, 2])
    expect(attempts()).toBe(1)
    expect(readChildEnv(envFile).batchWorker).toBe('false')
    expect(client.getEmbedderState()).toBe('ok')
  } finally {
    process.argv.splice(0, process.argv.length, ...argv)
    config.mcp.stdioStandalone = stdioStandalone
    await client.stopEmbedderProcess().catch(() => {})
    delete process.env.SYNAPTOMIND_STUB_ENV_FILE
  }
})

test('a standalone stdio session leaves the child batch-worker flag unset', async () => {
  const argv = [...process.argv]
  const stdioStandalone = config.mcp.stdioStandalone
  process.argv.push('--stdio', '--stdio-standalone')
  config.mcp.stdioStandalone = false
  const { envFile } = envStubScratch()
  const client = new EmbedderClient()
  try {
    await client.startEmbedderProcess()

    expect(readChildEnv(envFile).batchWorker).toBeNull()
  } finally {
    process.argv.splice(0, process.argv.length, ...argv)
    config.mcp.stdioStandalone = stdioStandalone
    await client.stopEmbedderProcess().catch(() => {})
    delete process.env.SYNAPTOMIND_STUB_ENV_FILE
  }
})
