import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const INDEX_TS = resolve(import.meta.dir, 'index.ts')
// VEC0 resolved via preload into process.env; inherited by the child.

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

describe('parent shutdown invokes closeDb (no WAL residue)', () => {
  test('SIGTERM removes the -wal sidecar', async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-shutdown-'))
    const dbPath = join(SCRATCH, 'test.db')

    const child = spawn(process.execPath, ['run', INDEX_TS, '--stdio', '--no-embedder'], {
      cwd: SCRATCH,
      env: {
        ...process.env,
        SYNAPTOMIND_DB_PATH: dbPath,
        SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Wait for the stdio server to be ready.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timeout')), 30_000)
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes('MCP server running in stdio mode')) {
          clearTimeout(timer)
          child.stderr.off('data', onData)
          resolve()
        }
      }
      child.stderr.on('data', onData)
      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })

    child.kill('SIGTERM')
    const code = await new Promise<number | null>(resolve => child.on('exit', resolve))

    expect(code).toBe(0)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
  }, 60_000)
})