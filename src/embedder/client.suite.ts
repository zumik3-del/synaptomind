import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../test/helpers'
import { closeDb } from '../db/init'
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

// Scratch dirs for the lifecycle stub's attempt counter, removed in afterEach.
const scratchDirs: string[] = []

beforeAll(() => {
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = STUB_PATH
})

afterAll(() => {
  delete process.env.SYNAPTOMIND_EMBEDDER_SCRIPT
})

beforeEach(createTestDb)

afterEach(async () => {
  // stop before closeDb: the client's stdout/stderr readers log into the DB
  await stopEmbedderProcess()
  closeDb()
  // Restore the default stub: a lifecycle script must not leak into the next test.
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = STUB_PATH
  delete process.env.SYNAPTOMIND_STUB_MODE
  delete process.env.SYNAPTOMIND_STUB_HANG_MS
  delete process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Point the client at the lifecycle stub; `attempts()` counts its spawns. */
function useLifecycleStub(mode: 'hang' | 'crash-then-recover', hangMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-embedder-'))
  scratchDirs.push(dir)
  const counter = join(dir, 'attempts')
  process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = LIFECYCLE_STUB_PATH
  process.env.SYNAPTOMIND_STUB_MODE = mode
  if (hangMs !== undefined) process.env.SYNAPTOMIND_STUB_HANG_MS = String(hangMs)
  process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE = counter
  return { attempts: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0) }
}

/** Poll `check` until it holds; fails the test rather than hanging the suite. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`)
}

test('startEmbedderProcess becomes ready against the stub subprocess', async () => {
  expect(isEmbedderReady()).toBe(false)

  await startEmbedderProcess()

  expect(isEmbedderReady()).toBe(true)
})

test('generateEmbedding round-trips through the stub IPC protocol', async () => {
  await startEmbedderProcess()

  // stub replies [text.length, 1, 2] — 'hello' → [5, 1, 2]
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

  // '__fail__' is the stub's designated error sentinel
  expect(generateEmbedding('__fail__')).rejects.toThrow('stub failure')
})

test('stopEmbedderProcess marks the client dead; the next request respawns it', async () => {
  await startEmbedderProcess()

  await stopEmbedderProcess()

  expect(isEmbedderReady()).toBe(false)

  // self-healing: a fresh subprocess is spawned on demand
  const embedding = await generateEmbedding('hello')
  expect(Array.from(embedding)).toEqual([5, 1, 2])
  expect(isEmbedderReady()).toBe(true)
})

// ── getEmbedderState(): the lifecycle the /health gate reads ────────────────
// The deploy gate cannot tell a first install from a dead child on isEmbedderReady()
// alone, so the state below is what src/services/health.service.ts reports as
// checks.embedder and what deploy/lib/common.sh wait_health reads. Each test
// asserts the state AND the payload it becomes, so the mapping is covered too.

test("getEmbedderState is 'stopped' before any spawn and 'ok' once the child reports ready", async () => {
  expect(getEmbedderState()).toBe('stopped')
  expect(getHealthService().checks.embedder).toBe('not ready')

  await startEmbedderProcess()

  expect(getEmbedderState()).toBe('ok')
  expect(getHealthService().checks.embedder).toBe('ok')
})

test("getEmbedderState stays 'starting' while the child is alive but has not reported ready", async () => {
  // The stub never sends 'ready': a first binary install legitimately loads the
  // model for minutes, and this must NOT read as a failure.
  const stub = useLifecycleStub('hang')
  const started = startEmbedderProcess()
  started.catch(() => {})

  await waitFor(() => stub.attempts() >= 1, 'the stub child to spawn')

  expect(getEmbedderState()).toBe('starting')
  expect(getHealthService().checks.embedder).toBe('not ready')
})

test('a crashed child latches getEmbedderState as failed until a real ready clears it', async () => {
  // The ERR_DLOPEN_FAILED crash loop (a unit rendered without
  // LD_LIBRARY_PATH): attempt 1 dies, attempt 2 is the in-flight retry,
  // attempt 3 recovers. Expected stderr noise from the client's crash guard:
  // "[embedder] process exited unexpectedly with code 1".
  const stub = useLifecycleStub('crash-then-recover', 2_000)

  const started = startEmbedderProcess()

  // The crash guard latches: /health now carries the failure the gate needs.
  await waitFor(() => getEmbedderState() === 'failed', "getEmbedderState to latch 'failed'")
  expect(getHealthService().checks.embedder).toBe('failed')

  // The retry loop respawns once a second. The live-but-not-ready retry must not
  // read as 'starting' again — an unlatched state flaps back here, and the gate
  // would then see a healthy-looking "not ready" forever.
  await waitFor(() => stub.attempts() >= 2, 'the retry attempt to spawn')
  expect(getEmbedderState()).toBe('failed')

  // A real 'ready' clears the latch, so a recovered embedder still passes.
  await started
  expect(getEmbedderState()).toBe('ok')
  expect(getHealthService().checks.embedder).toBe('ok')
}, 30_000)

test('a deliberate teardown leaves the state stopped instead of latching failed', async () => {
  await startEmbedderProcess()
  expect(getEmbedderState()).toBe('ok')

  // Idle unload / shutdown: the child exits through the same code path as a
  // crash, and must not be reported as one.
  await stopEmbedderProcess()

  expect(getEmbedderState()).toBe('stopped')
  expect(getHealthService().checks.embedder).toBe('not ready')
})
