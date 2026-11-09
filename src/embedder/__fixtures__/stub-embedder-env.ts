import { writeFileSync } from 'node:fs'

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

process.send?.({ type: 'ready' })

process.on('message', (raw: unknown) => {
  if ((raw as { type?: string })?.type === 'shutdown') process.exit(0)
})

setInterval(() => {}, 1_000)
