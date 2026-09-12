// IPC stub used by eval/isolation.test.ts via the SYNAPTOMIND_EMBEDDER_SCRIPT
// override. It speaks the same Bun IPC protocol as src/embedder/embedder-process.ts
// and writes a sentinel file on startup, which lets the test prove whether the
// embedder child process was spawned at all.
//
// Embeddings are produced with the harness's dependency-free feature-hashing
// embedder, so the `--real` path can be exercised offline (no model download)
// while still retrieving the right thoughts.

import { writeFileSync } from 'node:fs'
import { deterministicEmbedding } from '../embedding'

const sentinel = process.env.EVAL_STUB_SENTINEL
if (sentinel) writeFileSync(sentinel, `${process.pid}\n`)

process.send?.({ type: 'ready' })

process.on('message', (raw: unknown) => {
  const message = raw as {
    type?: string
    id?: string
    method?: string
    params?: { text?: string; texts?: string[] }
  }

  if (message.type === 'shutdown') {
    process.exit(0)
    return
  }
  if (message.type !== 'request') return

  if (message.method === 'embed') {
    const embedding = deterministicEmbedding(message.params?.text ?? '')
    process.send?.({ type: 'result', id: message.id, embedding: Array.from(embedding) })
    return
  }

  if (message.method === 'embed_batch') {
    const texts = message.params?.texts ?? []
    process.send?.({
      type: 'result',
      id: message.id,
      embedding: texts.map(text => Array.from(deterministicEmbedding(text)))
    })
    return
  }

  process.send?.({ type: 'error', id: message.id, error: `stub: unknown method ${message.method}` })
})
