import { describe, expect, jest, test } from 'bun:test'
import type { Subprocess } from 'bun'
import {
  EmbedderNotReadyError,
  EmbedderOverloadedError,
  EmbedderSendError,
  EmbedderTimeoutError,
  EmbedderUnavailableError
} from '../errors'
import { type IpcClientDeps, IpcClient } from './ipc-client'
import type { IpcMessage } from './ipc-protocol'

// The per-request timeout is a module constant (60 s); fake timers let the test
// reach it without waiting in real time.
const REQUEST_TIMEOUT_MS = 60_000

function deps(overrides: Partial<IpcClientDeps> = {}): IpcClientDeps {
  return {
    getProc: () => ({ send: () => {} }) as unknown as Subprocess,
    isAlive: () => true,
    onSendFailure: () => {},
    ...overrides
  }
}

describe('IpcClient typed transient failures', () => {
  test('an unanswered request rejects with EmbedderTimeoutError (statusCode 503) once the timeout fires', async () => {
    jest.useFakeTimers()
    try {
      const client = new IpcClient(deps())
      const captured = client.sendRequest('embed_batch', { texts: ['x'] }).catch(e => e)

      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS)

      const err: unknown = await captured
      expect(err).toBeInstanceOf(EmbedderTimeoutError)
      expect((err as EmbedderTimeoutError).statusCode).toBe(503)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a throw from proc.send rejects with EmbedderSendError (statusCode 503) and latches the crash', async () => {
    let sendFailure = false
    const client = new IpcClient(
      deps({
        getProc: () =>
          ({
            send: () => {
              throw new Error('pipe closed')
            }
          }) as unknown as Subprocess,
        onSendFailure: () => {
          sendFailure = true
        }
      })
    )

    const err: unknown = await client.sendRequest('embed_batch', { texts: ['x'] }).catch(e => e)

    expect(err).toBeInstanceOf(EmbedderSendError)
    expect((err as EmbedderSendError).statusCode).toBe(503)
    expect(sendFailure).toBe(true)
  })
})

interface CapturingClient {
  client: IpcClient
  requestId: () => string
  reply: (message: unknown) => void
}

function capturingClient(): CapturingClient {
  let sent: { id?: string } | null = null
  const client = new IpcClient(
    deps({
      getProc: () =>
        ({
          send: (message: { id?: string }) => {
            sent = message
          }
        }) as unknown as Subprocess
    })
  )
  return {
    client,
    requestId: () => String(sent?.id),
    reply: message => client.dispatch(message as IpcMessage)
  }
}

const CODED_ERRORS = [
  ['not_ready', EmbedderNotReadyError],
  ['overloaded', EmbedderOverloadedError],
  ['timeout', EmbedderTimeoutError],
  ['send_failure', EmbedderSendError],
  ['unavailable', EmbedderUnavailableError]
] as const

describe('IpcClient rebuilds the typed failure from the reply code', () => {
  for (const [code, Ctor] of CODED_ERRORS) {
    test(`code '${code}' rejects with ${Ctor.name} (${new Ctor().statusCode})`, async () => {
      const { client, requestId, reply } = capturingClient()
      const pending = client.sendRequest('embed', { text: 'x' }).catch(e => e)

      reply({ type: 'error', id: requestId(), error: `child said ${code}`, code })

      const err: unknown = await pending
      expect(err).toBeInstanceOf(Ctor)
      expect((err as Error).name).toBe(Ctor.name)
      expect((err as Error).message).toBe(`child said ${code}`)
      const statusCode = (err as { statusCode: number }).statusCode
      expect(statusCode).toBe(503)
      expect(statusCode).toBeGreaterThanOrEqual(400)
      expect(statusCode).toBeLessThan(600)
    })
  }

  test('an error reply without a code stays a plain Error (500 at the API handler)', async () => {
    const { client, requestId, reply } = capturingClient()
    const pending = client.sendRequest('embed', { text: 'x' }).catch(e => e)

    reply({ type: 'error', id: requestId(), error: 'child said nothing' })

    const err: unknown = await pending
    expect((err as Error).constructor).toBe(Error)
    expect(Object.hasOwn(err as object, 'statusCode')).toBe(false)
  })

  test('an unknown code stays a plain Error instead of inventing a class', async () => {
    const { client, requestId, reply } = capturingClient()
    const pending = client.sendRequest('embed', { text: 'x' }).catch(e => e)

    reply({ type: 'error', id: requestId(), error: 'child said bogus', code: 'bogus' })

    const err: unknown = await pending
    expect((err as Error).constructor).toBe(Error)
    expect((err as Error).message).toBe('child said bogus')
    expect(Object.hasOwn(err as object, 'statusCode')).toBe(false)
  })
})

describe('IpcClient rejects an unusable embedding payload', () => {
  for (const [name, embedding] of [
    ['missing', undefined],
    ['empty', []]
  ] as const) {
    test(`a ${name} embedding rejects with EmbedderUnavailableError instead of returning a zero-length vector`, async () => {
      const { client, requestId, reply } = capturingClient()
      const pending = client.sendRequest('embed', { text: 'x' }).catch(e => e)

      reply({ type: 'result', id: requestId(), embedding })

      const err: unknown = await pending
      expect(err).toBeInstanceOf(EmbedderUnavailableError)
      expect((err as Error).message).toBe('Embedder returned an empty embedding payload')
      expect((err as EmbedderUnavailableError).statusCode).toBe(503)
    })
  }

  test('a non-empty payload still resolves to Float32Array vectors', async () => {
    const { client, requestId, reply } = capturingClient()
    const pending = client.sendRequest('embed_batch', { texts: ['a', 'b'] })

    reply({
      type: 'result',
      id: requestId(),
      embedding: [
        [1, 2],
        [3, 4]
      ]
    })

    const vectors = (await pending) as Float32Array[]
    expect(vectors.map(v => Array.from(v))).toEqual([
      [1, 2],
      [3, 4]
    ])
  })
})
