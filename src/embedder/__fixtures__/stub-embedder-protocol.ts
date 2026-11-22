import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const counter = process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE
const previous =
  counter && existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) || 0 : 0
if (counter) writeFileSync(counter, String(previous + 1))

const protocol = process.env.SYNAPTOMIND_STUB_PROTOCOL
if (protocol === 'absent') {
  process.send?.({ type: 'ready' })
} else {
  process.send?.({ type: 'ready', protocol: Number(protocol ?? '1') })
}

process.on('message', (raw: unknown) => {
  if ((raw as { type?: string })?.type === 'shutdown') process.exit(0)
})

setInterval(() => {}, 1_000)
