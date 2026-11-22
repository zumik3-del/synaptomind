import { EMBEDDER_IPC_PROTOCOL_VERSION } from '../ipc-protocol'

process.send?.({ type: 'ready', protocol: EMBEDDER_IPC_PROTOCOL_VERSION })

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

  if (message.params?.text === '__typed__') {
    process.send?.({
      type: 'error',
      id: message.id,
      error: 'stub failure: model is loading',
      code: 'not_ready'
    })
    return
  }

  if (message.params?.text === '__empty__') {
    process.send?.({ type: 'result', id: message.id })
    return
  }

  if (message.method === 'embed') {
    const text = message.params?.text ?? ''
    process.send?.({ type: 'result', id: message.id, embedding: [text.length, 1, 2] })
    return
  }

  if (message.method === 'embed_batch') {
    const texts = message.params?.texts ?? []
    if (texts.includes('__short__')) {
      process.send?.({ type: 'result', id: message.id, embedding: [[1, 1, 2]] })
      return
    }
    process.send?.({ type: 'result', id: message.id, embedding: texts.map(t => [t.length, 1, 2]) })
    return
  }

  process.send?.({ type: 'error', id: message.id, error: `stub: unknown method ${message.method}` })
})
