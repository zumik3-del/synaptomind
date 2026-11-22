import { closeDb, initDb } from '../../db/init'
import { EMBEDDER_IPC_PROTOCOL_VERSION } from '../ipc-protocol'

initDb()

process.send?.({ type: 'ready', protocol: EMBEDDER_IPC_PROTOCOL_VERSION })

process.on('message', (raw: unknown) => {
  const message = raw as { type?: string }
  if (message?.type === 'shutdown') {
    closeDb()
    process.exit(0)
  }
})

setInterval(() => {}, 60_000)
