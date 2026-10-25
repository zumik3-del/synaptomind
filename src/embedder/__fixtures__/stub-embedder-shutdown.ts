// Minimal stand-in for embedder-process.ts used by
// embedder-shutdown-closeDb.test.ts. Speaks the same Bun IPC protocol and
// exercises closeDb() on shutdown, but imports no model / network code, so the
// test never downloads into the source tree or hits the network.
import { closeDb, initDb } from '../../db/init'

initDb()

process.send?.({ type: 'ready' })

process.on('message', (raw: unknown) => {
  const message = raw as { type?: string }
  if (message?.type === 'shutdown') {
    closeDb()
    process.exit(0)
  }
})

// Keep the event loop alive until a shutdown message arrives.
setInterval(() => {}, 60_000)