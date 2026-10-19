import { describe, expect, jest, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { EmbedderSendError, EmbedderTimeoutError } from '../errors'
import { type IpcClientDeps, IpcClient } from './ipc-client'

// Regression coverage for #1756 (audit M6): the two transient IPC failures the
// embedder child can produce must reject with typed, retryable errors instead of
// plain `Error`s, so the MCP layer can classify them (see error-envelope.test.ts).

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
        getProc: () => ({ send: () => { throw new Error('pipe closed') } }) as unknown as Subprocess,
        onSendFailure: () => { sendFailure = true }
      })
    )

    const err: unknown = await client.sendRequest('embed_batch', { texts: ['x'] }).catch(e => e)

    expect(err).toBeInstanceOf(EmbedderSendError)
    expect((err as EmbedderSendError).statusCode).toBe(503)
    expect(sendFailure).toBe(true)
  })
})
