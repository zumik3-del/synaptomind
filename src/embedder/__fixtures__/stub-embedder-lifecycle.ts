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
//
// SYNAPTOMIND_STUB_ATTEMPT_FILE counts spawns into a file, so the parent can
// tell which attempt is in flight without racing on the client's own state.
// SYNAPTOMIND_STUB_HANG_MS is how long attempt 2 stays alive before dying (the
// window in which an unlatched state would read 'starting'). The client
// forwards the environment to the child (spawnProcess passes ...process.env).
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

if (process.env.SYNAPTOMIND_STUB_MODE === 'crash-then-recover') {
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