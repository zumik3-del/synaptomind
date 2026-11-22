import {
  EmbedderNotReadyError,
  EmbedderOverloadedError,
  EmbedderSendError,
  EmbedderTimeoutError,
  EmbedderUnavailableError
} from '../errors'

// One table for both directions of the IPC error path: the child labels a failure with the code of
// the error class it threw, and the client rebuilds that same class from the code.
export const EMBEDDER_ERROR_CLASSES = {
  not_ready: EmbedderNotReadyError,
  overloaded: EmbedderOverloadedError,
  timeout: EmbedderTimeoutError,
  send_failure: EmbedderSendError,
  unavailable: EmbedderUnavailableError
} as const

export type EmbedderErrorCode = keyof typeof EMBEDDER_ERROR_CLASSES

export function embedderErrorFromCode(code: string | undefined, message: string): Error {
  if (code === undefined || !Object.hasOwn(EMBEDDER_ERROR_CLASSES, code)) return new Error(message)
  const Ctor = EMBEDDER_ERROR_CLASSES[code as EmbedderErrorCode]
  return new Ctor(message)
}

export function embedderErrorCode(err: unknown): EmbedderErrorCode | undefined {
  if (err instanceof EmbedderNotReadyError) return 'not_ready'
  if (err instanceof EmbedderOverloadedError) return 'overloaded'
  if (err instanceof EmbedderTimeoutError) return 'timeout'
  if (err instanceof EmbedderSendError) return 'send_failure'
  if (err instanceof EmbedderUnavailableError) return 'unavailable'
  return undefined
}
