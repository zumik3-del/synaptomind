import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EMBEDDER_IPC_PROTOCOL_VERSION } from '../ipc-protocol'

const counter = process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE
if (counter) {
  const previous = existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) || 0 : 0
  writeFileSync(counter, String(previous + 1))
}

const file = process.env.SYNAPTOMIND_STUB_ENV_FILE
if (file) {
  writeFileSync(
    file,
    JSON.stringify({
      precache: process.env.SYNAPTOMIND_EMBEDDER_PRECACHE ?? null,
      idleTimeoutMs: process.env.SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT ?? null,
      users: process.env.SYNAPTOMIND_EMBEDDER_USERS ?? null,
      batchWorker: process.env.SYNAPTOMIND_EMBEDDER_BATCH_WORKER ?? null
    })
  )
}

process.send?.({ type: 'ready', protocol: EMBEDDER_IPC_PROTOCOL_VERSION })

process.on('message', (raw: unknown) => {
  const message = raw as {
    type?: string
    id?: string
    method?: string
    params?: { text?: string; texts?: string[] }
  }
  if (message?.type === 'shutdown') process.exit(0)
  if (message?.type !== 'request') return
  if (message.method === 'embed_batch') {
    const texts = message.params?.texts ?? []
    process.send?.({ type: 'result', id: message.id, embedding: texts.map(t => [t.length, 1, 2]) })
    return
  }
  const text = message.params?.text ?? ''
  process.send?.({ type: 'result', id: message.id, embedding: [text.length, 1, 2] })
})

setInterval(() => {}, 1_000)
