import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  installProcessHandlers,
  type ProcessHandlerBinder,
  type ProcessLogFn
} from './process-handlers'

type Handler = (value: unknown) => void
type Event = 'exit' | 'uncaughtException' | 'unhandledRejection'

interface RecordingBinder {
  binder: ProcessHandlerBinder
  emit: (event: Event, value: unknown) => void
}

function recordingBinder(): RecordingBinder {
  const handlers = new Map<Event, Handler>()
  const binder = {
    on(event: Event, listener: Handler) {
      handlers.set(event, listener)
      return binder
    }
  } as unknown as ProcessHandlerBinder
  return {
    binder,
    emit(event, value) {
      const handler = handlers.get(event)
      if (handler === undefined) throw new Error(`no listener registered for ${event}`)
      handler(value)
    }
  }
}

const CRASH_FIXTURE = resolve(import.meta.dir, 'test', 'process-handlers-crash.ts')

let SCRATCH = ''
let stderr: string[] = []
let writeSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>
let exitSpy: ReturnType<typeof spyOn<typeof process, 'exit'>>

beforeEach(() => {
  stderr = []
  writeSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stderr.write)
  exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
})

afterEach(() => {
  writeSpy.mockRestore()
  exitSpy.mockRestore()
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

describe('installProcessHandlers', () => {
  test('unhandledRejection logs the Error message and its stack without exiting', () => {
    const { binder, emit } = recordingBinder()
    const calls: Parameters<ProcessLogFn>[] = []
    installProcessHandlers({ process: binder, log: (...args) => calls.push(args) })
    const error = new Error('rejection boom')

    expect(() => emit('unhandledRejection', error)).not.toThrow()

    expect(stderr).toEqual(['[synaptomind] Unhandled rejection: rejection boom\n'])
    expect(calls).toEqual([
      ['error', 'process', 'Unhandled rejection', { error: error.stack ?? error.message }]
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('uncaughtException logs the Error message and its stack without exiting', () => {
    const { binder, emit } = recordingBinder()
    const calls: Parameters<ProcessLogFn>[] = []
    installProcessHandlers({ process: binder, log: (...args) => calls.push(args) })
    const error = new Error('uncaught boom')

    expect(() => emit('uncaughtException', error)).not.toThrow()

    expect(stderr).toEqual(['[synaptomind] Uncaught exception: uncaught boom\n'])
    expect(calls).toEqual([
      ['error', 'process', 'Uncaught exception', { error: error.stack ?? error.message }]
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('a non-Error rejection reason is stringified for stderr and the log payload', () => {
    const { binder, emit } = recordingBinder()
    const calls: Parameters<ProcessLogFn>[] = []
    installProcessHandlers({ process: binder, log: (...args) => calls.push(args) })

    expect(() => emit('unhandledRejection', 'plain reason')).not.toThrow()

    expect(stderr).toEqual(['[synaptomind] Unhandled rejection: plain reason\n'])
    expect(calls).toEqual([['error', 'process', 'Unhandled rejection', { error: 'plain reason' }]])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('a non-Error thrown value is stringified for stderr and the log payload', () => {
    const { binder, emit } = recordingBinder()
    const calls: Parameters<ProcessLogFn>[] = []
    installProcessHandlers({ process: binder, log: (...args) => calls.push(args) })

    expect(() => emit('uncaughtException', { code: 42 })).not.toThrow()

    expect(stderr).toEqual(['[synaptomind] Uncaught exception: [object Object]\n'])
    expect(calls).toEqual([
      ['error', 'process', 'Uncaught exception', { error: '[object Object]' }]
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('the exit listener reports the exit code on stderr', () => {
    const { binder, emit } = recordingBinder()
    const calls: Parameters<ProcessLogFn>[] = []
    installProcessHandlers({ process: binder, log: (...args) => calls.push(args) })

    expect(() => emit('exit', 42)).not.toThrow()

    expect(stderr).toEqual(['[synaptomind] process exiting with code 42\n'])
    expect(calls).toEqual([])
  })
})

async function runFixture(args: string[] = []): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-process-handlers-'))
  const proc = Bun.spawn(['bun', 'run', CRASH_FIXTURE, ...args], {
    cwd: SCRATCH,
    env: {
      ...process.env,
      SYNAPTOMIND_DB_PATH: join(SCRATCH, 'db', 'synaptomind.db'),
      SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
      SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'cache')
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderrText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  clearTimeout(timer)
  return { code, stdout, stderr: stderrText }
}

describe('installProcessHandlers in a real process', () => {
  test('an unhandled rejection and a timer throw are logged and the process survives', async () => {
    const result = await runFixture()
    const output = result.stdout + result.stderr
    if (result.code !== 0) console.error(output)

    expect(result.code, output).toBe(0)
    expect(result.stdout).toContain('SURVIVED')
    expect(result.stderr).toContain('[synaptomind] Unhandled rejection: fixture rejection')
    expect(result.stderr).toContain('[synaptomind] Uncaught exception: fixture timer throw')
  }, 30_000)

  test('the exit listener reports the code of a real exit', async () => {
    const result = await runFixture(['7'])
    if (result.code !== 7) console.error(result.stdout + result.stderr)

    expect(result.code).toBe(7)
    expect(result.stderr).toContain('[synaptomind] process exiting with code 7')
  }, 30_000)
})
