import { describe, expect, test } from 'bun:test'
import { type LogEntry, Logger, StreamSink } from './log'

const TS = '2026-01-01T00:00:00.000Z'

function sinkLine(entry: LogEntry, format: 'text' | 'json'): string {
  let written = ''
  const sink = new StreamSink({
    stdout: {
      write: (chunk: string) => {
        written += chunk
        return true
      }
    },
    stderr: {
      write: (chunk: string) => {
        written += chunk
        return true
      }
    },
    stdio: false,
    format
  })
  sink.write(entry)
  return written
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: TS,
    level: 'error',
    type: 'process',
    source: 'synaptomind',
    message: 'Unhandled rejection',
    ...overrides
  }
}

describe('formatEntry text mode', () => {
  test('renders the error JSON-escaped on the same physical line', () => {
    const error = 'rejection boom\n    at handler (src/index.ts:1:1)'

    const line = sinkLine(entry({ error }), 'text')
    const physical = line.slice(0, -1)

    expect(line).toBe(
      `${TS} error [process] [synaptomind] Unhandled rejection error=${JSON.stringify(error)}\n`
    )
    expect(physical).not.toContain('\n')
    expect(physical).toContain('error="rejection boom\\n    at handler')
  })

  test('renders metadata before the error', () => {
    const line = sinkLine(entry({ metadata: { attempt: 2 }, error: 'boom' }), 'text')

    expect(line).toBe(
      `${TS} error [process] [synaptomind] Unhandled rejection {"attempt":2} error="boom"\n`
    )
  })

  test('an entry without an error is unchanged', () => {
    expect(sinkLine(entry(), 'text')).toBe(
      `${TS} error [process] [synaptomind] Unhandled rejection\n`
    )
    expect(sinkLine(entry({ metadata: { attempt: 2 } }), 'text')).toBe(
      `${TS} error [process] [synaptomind] Unhandled rejection {"attempt":2}\n`
    )
  })
})

describe('formatEntry JSON mode', () => {
  test('keeps the error property alongside the decoded message', () => {
    const error = 'rejection boom\n    at handler (src/index.ts:1:1)'

    const parsed = JSON.parse(sinkLine(entry({ error, metadata: { attempt: 2 } }), 'json'))

    expect(parsed).toEqual({
      ts: TS,
      level: 'error',
      type: 'process',
      source: 'synaptomind',
      msg: 'Unhandled rejection',
      meta: { attempt: 2 },
      error
    })
  })

  test('an entry without an error has no error property', () => {
    const parsed = JSON.parse(sinkLine(entry(), 'json'))

    expect(parsed).toEqual({
      ts: TS,
      level: 'error',
      type: 'process',
      source: 'synaptomind',
      msg: 'Unhandled rejection'
    })
    expect('error' in parsed).toBe(false)
  })
})

describe('Logger.insertLog error field', () => {
  function loggerLine(error: string, format: 'text' | 'json'): string {
    let written = ''
    const stream = {
      write: (chunk: string) => {
        written += chunk
        return true
      }
    }
    const logger = new Logger({
      level: 'info',
      file: '',
      format,
      stdio: false,
      stdout: stream,
      stderr: stream
    })
    logger.insertLog('error', 'process', 'Unhandled rejection', { error })
    return written
  }

  test('moves a metadata error out of the metadata into the error field', () => {
    const error = 'rejection boom\n    at handler (src/index.ts:1:1)'

    const line = loggerLine(error, 'text')
    const physical = line.slice(0, -1)

    expect(physical).toContain(`error=${JSON.stringify(error)}`)
    expect(physical).not.toContain('\n')
    expect(physical).not.toContain('"error"')
  })

  test('reaches the JSON entry error property', () => {
    const parsed = JSON.parse(loggerLine('boom', 'json'))

    expect(parsed.error).toBe('boom')
    expect(parsed.meta).toEqual({})
  })
})
