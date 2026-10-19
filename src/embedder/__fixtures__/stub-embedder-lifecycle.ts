// Lifecycle stub for the embedder client (client.suite.ts). Unlike
// stub-embedder.ts — which is ready the instant it starts and only exists to
// answer requests — this one NEVER loads a model: it replays a scripted
// spawn/exit pattern so getEmbedderState()'s latch can be observed from the
// parent. It speaks the same Bun IPC protocol and imports nothing from the app.
//
// SYNAPTOMIND_STUB_MODE selects the script:
//   'hang'                every attempt stays alive and never sends 'ready'
//                         (a slow model load / an embedder that never finishes)
//   'crash-then-recover'  the ERR_DLOPEN_FAILED crash loop a unit rendered
//                         without LD_LIBRARY_PATH produces (attempt 1 exits 1),
//                         then an in-flight retry that is alive but not ready
//                         (attempt 2), then a respawn that becomes ready
//                         (attempt 3+, the recovery)
//   'ready-no-answer'     announces 'ready' and then swallows every request,
//                         staying alive until torn down — the state a deliberate
//                         teardown (shutdown/restart) finds in flight (#1773)
//   'idle-exit-on-request' announces 'ready', then on the first request sends
//                         {'exiting'} (the parent-side idle unload) and leaves
//                         without answering — the request stays in flight (#1773)
//   'crash-on-request'    announces 'ready', then exits code 1 on the first
//                         request without answering — the hard crash path (#1773)
//   'idle-exit-once'      attempt 1 announces 'ready' and, on its first request,
//                         sends {'exiting'} then lingers SYNAPTOMIND_STUB_HANG_MS
//                         before exiting; attempt 2+ serves requests like
//                         stub-embedder — the superseded-child race of #1784: the
//                         respawned successor is already live when attempt 1's
//                         late `exited` fires, so that exit must be inert.
//
// SYNAPTOMIND_STUB_ATTEMPT_FILE counts spawns into a file, so the parent can
// tell which attempt is in flight without racing on the client's own state.
// SYNAPTOMIND_STUB_HANG_MS is how long attempt 2 stays alive before dying (the
// window in which an unlatched state would read 'starting'); in 'idle-exit-once'
// it is instead how long attempt 1 lingers after 'exiting' (the window in which
// its successor spawns and becomes ready). SYNAPTOMIND_STUB_EXIT_FILE is written
// by 'idle-exit-once' attempt 1 just before it exits, so the parent can await the
// late exit deterministically. The client forwards the environment to the child
// (spawnProcess passes ...process.env).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const counter = process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE
const previous =
  counter && existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) || 0 : 0
const attempt = previous + 1
if (counter) writeFileSync(counter, String(attempt))

/** Stay alive until the client tears us down; never announce readiness. */
function idle(): void {
  process.on('message', (raw: unknown) => {
    if ((raw as { type?: string })?.type === 'shutdown') process.exit(0)
  })
  setInterval(() => {}, 1_000)
}

const mode = process.env.SYNAPTOMIND_STUB_MODE

/**
 * Announce readiness, then replay the per-request lifecycle of the mode. Used by
 * the #1773 reject paths: a request is in flight when the child leaves.
 */
function answering(): void {
  process.send?.({ type: 'ready' })
  process.on('message', (raw: unknown) => {
    const message = raw as { type?: string; id?: string }
    if (message?.type === 'shutdown') process.exit(0)
    if (message?.type !== 'request') return
    // Signal receipt through a file so the parent can synchronise on the request
    // being registered in its pending map before it triggers a reject path.
    const requestFile = process.env.SYNAPTOMIND_STUB_REQUEST_FILE
    if (requestFile) writeFileSync(requestFile, message.id ?? '')
    if (mode === 'idle-exit-on-request' || mode === 'idle-exit-once') {
      // The idle unload: the parent's IPC handler sees 'exiting' while the
      // request is still pending, then the process leaves on its own. In
      // 'idle-exit-once' the exit is delayed by SYNAPTOMIND_STUB_HANG_MS so the
      // respawned successor is live before this stale `exited` fires (#1784).
      const lingerMs = mode === 'idle-exit-once' ? Number(process.env.SYNAPTOMIND_STUB_HANG_MS ?? '1500') : 25
      setTimeout(() => {
        process.send?.({ type: 'exiting' })
        setTimeout(() => {
          const exitFile = process.env.SYNAPTOMIND_STUB_EXIT_FILE
          if (exitFile) writeFileSync(exitFile, String(attempt))
          process.exit(0)
        }, lingerMs)
      }, 25)
      return
    }
    if (mode === 'crash-on-request') {
      process.exit(1)
      return
    }
    // 'ready-no-answer': stay alive and swallow the request.
  })
  setInterval(() => {}, 1_000)
}

/**
 * Announce readiness and answer requests exactly like stub-embedder ([len,1,2]),
 * staying alive until torn down. The 'idle-exit-once' successor (attempt 2+) uses
 * this so the client can observe it as healthy after the stale exit.
 */
function serving(): void {
  process.send?.({ type: 'ready' })
  process.on('message', (raw: unknown) => {
    const message = raw as {
      type?: string
      id?: string
      method?: string
      params?: { text?: string; texts?: string[] }
    }
    if (message?.type === 'shutdown') process.exit(0)
    if (message?.type !== 'request') return
    const requestFile = process.env.SYNAPTOMIND_STUB_REQUEST_FILE
    if (requestFile) writeFileSync(requestFile, message.id ?? '')
    if (message.method === 'embed') {
      process.send?.({ type: 'result', id: message.id, embedding: [(message.params?.text ?? '').length, 1, 2] })
      return
    }
    if (message.method === 'embed_batch') {
      const texts = message.params?.texts ?? []
      process.send?.({ type: 'result', id: message.id, embedding: texts.map(t => [t.length, 1, 2]) })
      return
    }
    process.send?.({ type: 'error', id: message.id, error: `stub: unknown method ${message.method}` })
  })
  setInterval(() => {}, 1_000)
}

if (mode === 'idle-exit-once' && attempt >= 2) {
  serving()
} else if (mode === 'ready-no-answer' || mode === 'idle-exit-on-request' || mode === 'crash-on-request' || mode === 'idle-exit-once') {
  answering()
} else if (mode === 'crash-then-recover') {
  const hangMs = Number(process.env.SYNAPTOMIND_STUB_HANG_MS ?? '3000')
  if (attempt === 1) {
    process.exit(1)
  } else if (attempt === 2) {
    // Alive, no 'ready' — the state the latch exists to override.
    idle()
    setTimeout(() => process.exit(1), hangMs)
  } else {
    process.send?.({ type: 'ready' })
    idle()
  }
} else {
  idle()
}