import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const STUB_TS = resolve(import.meta.dir, '__fixtures__', 'stub-embedder-shutdown.ts')

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

describe('embedder child shutdown invokes closeDb (no WAL residue)', () => {
  test('shutdown message removes the -wal sidecar', async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-embedder-shutdown-'))
    const dbPath = join(SCRATCH, 'test.db')

    const child = spawn(process.execPath, ['run', STUB_TS], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        SYNAPTOMIND_DB_PATH: dbPath,
        SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT: '600000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })

    // Wait for the ready IPC (deterministic) instead of a fixed sleep.
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('ready timeout')), 30_000)
      child.on('message', (msg: unknown) => {
        if ((msg as { type?: string })?.type === 'ready') {
          clearTimeout(timer)
          resolvePromise()
        }
      })
      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', code => {
        clearTimeout(timer)
        reject(new Error(`child exited early: ${code}`))
      })
    })

    // The WAL sidecar must have existed before shutdown (not a vacuous pass).
    expect(existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)).toBe(true)

    child.send?.({ type: 'shutdown' })

    const code = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 15_000)
      child.on('exit', c => {
        clearTimeout(timer)
        resolve(c)
      })
    })

    expect(code).toBe(0)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
  }, 30_000)
})