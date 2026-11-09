import type { LogLevel } from './logging'

export type ProcessLogFn = (
  level: LogLevel,
  type: string,
  message: string,
  metadata?: Record<string, unknown>
) => void

export interface ProcessHandlerBinder {
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

export interface ProcessHandlerOptions {
  process?: ProcessHandlerBinder
  log?: ProcessLogFn
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function detail(value: unknown): string {
  return value instanceof Error ? (value.stack ?? value.message) : String(value)
}

function writeStderr(line: string): void {
  try {
    process.stderr.write(line)
  } catch {}
}

function defaultLog(
  level: LogLevel,
  type: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  void import('./logging')
    .then(({ insertLog }) => insertLog(level, type, message, metadata))
    .catch(() => {})
}

export function installProcessHandlers(opts: ProcessHandlerOptions = {}): void {
  const proc = opts.process ?? (process as ProcessHandlerBinder)
  const log = opts.log ?? defaultLog
  const record = (label: string, value: unknown): void => {
    writeStderr(`[synaptomind] ${label}: ${describe(value)}\n`)
    log('error', 'process', label, { error: detail(value) })
  }
  proc.on('unhandledRejection', reason => record('Unhandled rejection', reason))
  proc.on('uncaughtException', error => record('Uncaught exception', error))
  proc.on('exit', code => {
    writeStderr(`[synaptomind] process exiting with code ${code}\n`)
  })
}
