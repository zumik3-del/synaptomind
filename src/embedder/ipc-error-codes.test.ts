import { describe, expect, test } from 'bun:test'
import {
  EmbedderNotReadyError,
  EmbedderOverloadedError,
  EmbedderSendError,
  EmbedderTimeoutError,
  EmbedderUnavailableError
} from '../errors'
import {
  EMBEDDER_ERROR_CLASSES,
  type EmbedderErrorCode,
  embedderErrorCode,
  embedderErrorFromCode
} from './ipc-error-codes'

const EXPECTED = [
  ['not_ready', EmbedderNotReadyError],
  ['overloaded', EmbedderOverloadedError],
  ['timeout', EmbedderTimeoutError],
  ['send_failure', EmbedderSendError],
  ['unavailable', EmbedderUnavailableError]
] as const

describe('EMBEDDER_ERROR_CLASSES', () => {
  test('the table holds exactly the five typed embedder failures', () => {
    expect(Object.keys(EMBEDDER_ERROR_CLASSES).sort()).toEqual(
      EXPECTED.map(([code]) => code).sort()
    )
  })

  for (const [code, Ctor] of EXPECTED) {
    test(`'${code}' rebuilds ${Ctor.name} with the statusCode the API error handler keys on`, () => {
      expect(EMBEDDER_ERROR_CLASSES[code]).toBe(Ctor)

      const err = embedderErrorFromCode(code, 'child said no')
      expect(err).toBeInstanceOf(Ctor)
      expect(err.name).toBe(Ctor.name)
      expect(err.message).toBe('child said no')
      expect((err as unknown as { statusCode: number }).statusCode).toBe(503)
    })

    test(`'${code}' round-trips back to the same code`, () => {
      expect(embedderErrorCode(new Ctor('child said no'))).toBe(code)
    })
  }

  test('an absent code rebuilds a plain Error', () => {
    const err = embedderErrorFromCode(undefined, 'no code')
    expect(err.constructor).toBe(Error)
    expect(err.message).toBe('no code')
    expect(Object.hasOwn(err, 'statusCode')).toBe(false)
  })

  test('an unknown code rebuilds a plain Error', () => {
    const err = embedderErrorFromCode('bogus', 'unknown code')
    expect(err.constructor).toBe(Error)
    expect(err.message).toBe('unknown code')
    expect(Object.hasOwn(err, 'statusCode')).toBe(false)
  })

  test('a prototype key is not treated as a code', () => {
    for (const code of ['toString', '__proto__', 'constructor']) {
      expect(embedderErrorFromCode(code, 'not a code').constructor).toBe(Error)
    }
  })

  test('a plain Error maps to no code', () => {
    expect(embedderErrorCode(new Error('model exploded'))).toBeUndefined()
    expect(embedderErrorCode('not an error')).toBeUndefined()
    expect(embedderErrorCode(undefined)).toBeUndefined()
  })

  test('every table key is a valid code for the reverse mapping', () => {
    for (const code of Object.keys(EMBEDDER_ERROR_CLASSES) as EmbedderErrorCode[]) {
      const Ctor = EMBEDDER_ERROR_CLASSES[code]
      expect(embedderErrorCode(new Ctor('x'))).toBe(code)
    }
  })
})
