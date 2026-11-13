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

setInterval(() => {}, 60_000)
