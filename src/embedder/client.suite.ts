import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../test/helpers'
import { closeDb } from '../db/init'
import { EmbedderUnavailableError } from '../errors'
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
  delete process.env.SYNAPTOMIND_STUB_REQUEST_FILE
  delete process.env.SYNAPTOMIND_STUB_EXIT_FILE
  delete process.env.EMBEDDER_BACKOFF_BASE_MS
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Shrink the client's start-failure backoff for the crash/cooldown cases.
 *
 * The production window is one second and doubles per attempt, so the three
 * cases below used to sleep ~5 s each (15.6 s of a 19 s suite). The window's
 * LENGTH is not under test — that the client backs off, latches and resumes is.
 * `EMBEDDER_BACKOFF_BASE_MS` is the supervisor's own override (same shape as
 * `EMBEDDER_START_TIMEOUT_MS`, which the deadline case injects).
 */
function shrinkBackoff(baseMs = 25): void {
  process.env.EMBEDDER_BACKOFF_BASE_MS = String(baseMs)
}

/**
 * Point the client at the lifecycle stub; `attempts()` counts its spawns and
 * `requestSeen()` flips once the stub has received an IPC request (the parent
 * has already registered it in its pending map at that point).
 */
function useLifecycleStub(
  mode: 'hang' | 'crash-then-recover' | 'ready-no-answer' | 'idle-exit-on-request' | 'crash-on-request' | 'idle-exit-once',
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
  shrinkBackoff()
  const stub = useLifecycleStub('crash-then-recover', 300)

  const started = startEmbedderProcess()

  // The crash guard latches: /health now carries the failure the gate needs.
  await waitFor(() => getEmbedderState() === 'failed', "getEmbedderState to latch 'failed'")
  expect(getHealthService().checks.embedder).toBe('failed')

  // The retry loop respawns after the (injected, ~25 ms) backoff. The
  // live-but-not-ready retry must not read as 'starting' again — an unlatched
  // state flaps back here, and the gate would then see a healthy-looking "not
  // ready" forever.
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

// ── #1773: the remaining transient reject paths are typed ───────────────────
// An idle unload, a crash and a deliberate teardown all drop every in-flight
// request. Before #1773 they rejected with a plain `Error` (HTTP 500, MCP not
// retryable); now each carries EmbedderUnavailableError (503) so the HTTP and
// MCP layers classify it as a retryable availability failure (audit M6). Each
// test leaves one request unanswered and triggers a different path in the stub.
//
// These three use their OWN EmbedderClient instead of the shared singleton: an
// 'exiting' child exits a beat after its IPC message, and that late
// child.exited bookkeeping (it latches dead) would otherwise clobber the next
// test's freshly spawned child. A private instance keeps the blast radius local.
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
  // Expected noise from the crash guard:
  // "[embedder] process exited unexpectedly with code 1".
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
  // Wait until the stub has the request: at that point the client has registered
  // it in its pending map, so the teardown below has something to reject.
  await waitFor(() => stub.requestSeen(), 'the stub to receive the request')
  await client.stopEmbedderProcess()

  const err: unknown = await pending

  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder shutting down')
}, 15_000)

// ── #1784: a superseded child's late exit must stay inert ───────────────────
// The idle unload sets the client's shared flags when the child sends 'exiting',
// and the very next request respawns with a bumped generation. The superseded
// child exits a beat LATER still, by which time its successor is already live —
// so the unguarded `exited` handler would null `proc`, latch `failed` and reject
// the successor's in-flight request. The per-spawn generation guard in
// embedder-client.ts (the `exiting` IPC at :144 and the `exited` handler at :224)
// is what makes that late exit inert. A private client keeps a regressed guard's
// damage out of the shared singleton the rest of the suite uses.
test('a superseded idle-exit child cannot clobber its respawned successor (#1784)', async () => {
  // Attempt 1 lingers 0.5 s after 'exiting' — several times the ~60 ms a stub
  // spawn plus its 'ready' takes, so the successor is live well inside the
  // window and the stale `exited` races a LIVE successor.
  const stub = useLifecycleStub('idle-exit-once', 500)
  const client = new EmbedderClient()
  await client.startEmbedderProcess()
  expect(client.getEmbedderState()).toBe('ok')

  // (1) the idle unload: the in-flight request is rejected as a 503
  const err: unknown = await client.generateEmbedding('hello').catch(e => e)
  expect(err).toBeInstanceOf(EmbedderUnavailableError)
  expect((err as EmbedderUnavailableError).statusCode).toBe(503)
  expect((err as Error).message).toBe('Embedder process went idle')

  // (2) the next request respawns the child (generation++); attempt 2 serves it
  const vector = await client.generateEmbedding('hello')
  expect(Array.from(vector)).toEqual([5, 1, 2])

  // (3) attempt 1 has since exited: its late `exited` must have been ignored
  await waitFor(() => stub.exited(), 'the superseded child to exit')
  await new Promise(r => setTimeout(r, 50))

  expect(client.getEmbedderState()).toBe('ok')
  expect(Array.from(await client.generateEmbedding('hello'))).toEqual([5, 1, 2])

  await client.stopEmbedderProcess()
}, 20_000)

// ── #2153: single-flight readiness, backoff/cooldown, kill-before-respawn ───
// Coverage for the hardening in embedder-client.ts: one shared promise/owner,
// child killed before respawn, exponential backoff + cooldown on startFailed,
// and unref()'d wait timers.

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
  }, "startFailed to latch")

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
  // Use a fresh client to avoid disturbing the shared singleton.
  const c = new EmbedderClient()
  // Point at default stub by leaving env as STUB_PATH (afterEach restores).
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

  // More texts than a single chunk (EMBEDDER_BATCH_CHUNK = 64), and one chunk
  // boundary crossed exactly: several sequential `embed_batch` requests must be
  // concatenated back into input order instead of one oversized request.
  const texts = Array.from({ length: 200 }, (_, i) => 'x'.repeat(i + 1))

  const embeddings = await generateEmbeddings(texts)

  expect(embeddings).toHaveLength(texts.length)
  // The stub echoes `[text.length, 1, 2]`, so the position of each vector proves
  // the chunk results stayed aligned with the input.
  embeddings.forEach((vector, i) => {
    expect(Array.from(vector)).toEqual([texts[i]!.length, 1, 2])
  })
})

// ── #2166/#2171: review-fix verification ────────────────────────────────────

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
  internals.waitForExit = (p: unknown) => new Promise<void>(resolve => {
    setTimeout(() => { void origWaitForExit(p).then(resolve) }, 200)
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
  // A window the poller can observe, still far below the production second: the
  // behaviour under test is the WAIT, not its duration.
  shrinkBackoff(300)
  const stub = useLifecycleStub('crash-then-recover', 300)
  const client = new EmbedderClient()
  const started = client.startEmbedderProcess()
  started.catch(() => {})

  // Wait until the first crash has set a future cooldown.
  const internals = client as unknown as { backoffAttempt: number; cooldownUntil: number }
  await waitFor(() => internals.cooldownUntil > Date.now(), 'cooldownUntil to be set in the future')

  expect(internals.backoffAttempt).toBeGreaterThanOrEqual(1)

  // Reachable is not enough: the loop must really sleep. While the window is
  // still open, no respawn may happen (attempt 1 is the only one on disk). Sleep
  // only half of what is left, so scheduling jitter cannot land us past the edge.
  const attemptsAtLatch = stub.attempts()
  const remaining = internals.cooldownUntil - Date.now()
  await new Promise(r => setTimeout(r, Math.max(0, Math.floor(remaining / 2))))
  expect(stub.attempts()).toBe(attemptsAtLatch)

  await client.stopEmbedderProcess().catch(() => {})
  await started.catch(() => {})
}, 30_000)
