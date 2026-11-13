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

  if (message.params?.text === '__fail__') {
    process.send?.({ type: 'error', id: message.id, error: 'stub failure' })
    return
  }

  if (message.method === 'embed') {
    const text = message.params?.text ?? ''
    process.send?.({ type: 'result', id: message.id, embedding: [text.length, 1, 2] })
    return
  }

  if (message.method === 'embed_batch') {
    const texts = message.params?.texts ?? []
    process.send?.({ type: 'result', id: message.id, embedding: texts.map(t => [t.length, 1, 2]) })
    return
  }

  process.send?.({ type: 'error', id: message.id, error: `stub: unknown method ${message.method}` })
})
