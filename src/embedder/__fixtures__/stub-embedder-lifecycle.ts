import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const counter = process.env.SYNAPTOMIND_STUB_ATTEMPT_FILE
const previous =
  counter && existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) || 0 : 0
const attempt = previous + 1
if (counter) writeFileSync(counter, String(attempt))

function idle(): void {
  process.on('message', (raw: unknown) => {
    if ((raw as { type?: string })?.type === 'shutdown') process.exit(0)
  })
  setInterval(() => {}, 1_000)
}

const mode = process.env.SYNAPTOMIND_STUB_MODE

function answering(): void {
  process.send?.({ type: 'ready' })
  process.on('message', (raw: unknown) => {
    const message = raw as { type?: string; id?: string }
    if (message?.type === 'shutdown') process.exit(0)
    if (message?.type !== 'request') return
    const requestFile = process.env.SYNAPTOMIND_STUB_REQUEST_FILE
    if (requestFile) writeFileSync(requestFile, message.id ?? '')
    if (mode === 'idle-exit-no-msg') {
      const exitFile = process.env.SYNAPTOMIND_STUB_EXIT_FILE
      if (exitFile) writeFileSync(exitFile, String(attempt))
      process.exit(0)
      return
    }
    if (mode === 'idle-exit-on-request' || mode === 'idle-exit-once') {
      const lingerMs =
        mode === 'idle-exit-once' ? Number(process.env.SYNAPTOMIND_STUB_HANG_MS ?? '1500') : 25
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
  })
  setInterval(() => {}, 1_000)
}

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
      process.send?.({
        type: 'result',
        id: message.id,
        embedding: [(message.params?.text ?? '').length, 1, 2]
      })
      return
    }
    if (message.method === 'embed_batch') {
      const texts = message.params?.texts ?? []
      process.send?.({
        type: 'result',
        id: message.id,
        embedding: texts.map(t => [t.length, 1, 2])
      })
      return
    }
    process.send?.({
      type: 'error',
      id: message.id,
      error: `stub: unknown method ${message.method}`
    })
  })
  setInterval(() => {}, 1_000)
}

if ((mode === 'idle-exit-once' || mode === 'idle-exit-no-msg') && attempt >= 2) {
  serving()
} else if (
  mode === 'ready-no-answer' ||
  mode === 'idle-exit-on-request' ||
  mode === 'crash-on-request' ||
  mode === 'idle-exit-once' ||
  mode === 'idle-exit-no-msg'
) {
  answering()
} else if (mode === 'crash-then-recover') {
  const hangMs = Number(process.env.SYNAPTOMIND_STUB_HANG_MS ?? '3000')
  if (attempt === 1) {
    process.exit(1)
  } else if (attempt === 2) {
    idle()
    setTimeout(() => process.exit(1), hangMs)
  } else {
    process.send?.({ type: 'ready' })
    idle()
  }
} else {
  idle()
}
