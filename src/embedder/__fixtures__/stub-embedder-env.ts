import { writeFileSync } from 'node:fs'
import { EMBEDDER_IPC_PROTOCOL_VERSION } from '../ipc-protocol'

const file = process.env.SYNAPTOMIND_STUB_ENV_FILE
if (file) {
  writeFileSync(
    file,
    JSON.stringify({
      precache: process.env.SYNAPTOMIND_EMBEDDER_PRECACHE ?? null,
      idleTimeoutMs: process.env.SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT ?? null
    })
  )
}

process.send?.({ type: 'ready', protocol: EMBEDDER_IPC_PROTOCOL_VERSION })

process.on('message', (raw: unknown) => {
  if ((raw as { type?: string })?.type === 'shutdown') process.exit(0)
})

setInterval(() => {}, 1_000)
