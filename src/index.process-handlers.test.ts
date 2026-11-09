import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const INDEX_TS = resolve(import.meta.dir, 'index.ts')
const PRELOAD_TS = resolve(import.meta.dir, 'test', 'process-handlers-preload.ts')

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise(resolveWait => {
    const deadline = Date.now() + timeoutMs
    const poll = (): void => {
      if (condition()) {
        resolveWait(true)
        return
      }
      if (Date.now() >= deadline) {
        resolveWait(false)
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

describe('index.ts — the shipped process handlers', () => {
  test('an unhandled rejection after boot is logged, the server keeps serving and SIGTERM exits 0', async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'synapto-wiring-'))
    const portFile = join(SCRATCH, 'api-ports.json')
    const child = spawn(
      process.execPath,
      ['run', '--preload', PRELOAD_TS, INDEX_TS, '--no-embedder'],
      {
        cwd: SCRATCH,
        env: {
          ...process.env,
          SYNAPTOMIND_CONFIG: join(SCRATCH, 'config.json'),
          SYNAPTOMIND_PORT: '0',
          SYNAPTOMIND_MCP_HTTP_PORT: '0',
          SYNAPTOMIND_DB_PATH: join(SCRATCH, 'db', 'synaptomind.db'),
          SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
          SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'huggingface')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    let stdout = ''
    let stderr = ''
    let exitCode: number | null | undefined
    const exited = new Promise<number | null>(resolveExit => {
      child.once('exit', code => {
        exitCode = code
        resolveExit(code)
      })
    })
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const out = (): string => stdout + stderr
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 60_000)

    try {
      const booted = await waitFor(
        () => existsSync(portFile) && stdout.includes('[synaptomind] API server running on'),
        30_000
      )
      expect(booted, out()).toBe(true)

      const rejectionLine = '[synaptomind] Unhandled rejection: preload rejection'
      const logged = await waitFor(
        () => stderr.includes(rejectionLine) || exitCode !== undefined,
        30_000
      )
      expect(logged, out()).toBe(true)
      expect(stderr).toContain(rejectionLine)
      expect(exitCode, out()).toBeUndefined()

      const [port] = JSON.parse(readFileSync(portFile, 'utf8')) as number[]
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ status: 'ok' })
      expect(exitCode, out()).toBeUndefined()

      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(stderr).toContain('[synaptomind] process exiting with code 0')
    } finally {
      clearTimeout(killTimer)
      child.kill('SIGKILL')
    }
  }, 90_000)

  test('a stdio client disconnect runs the same shutdown and exits 0', async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'synapto-stdio-exit-'))
    const child = spawn(process.execPath, ['run', INDEX_TS, '--stdio', '--no-embedder'], {
      cwd: SCRATCH,
      env: {
        ...process.env,
        SYNAPTOMIND_CONFIG: join(SCRATCH, 'config.json'),
        SYNAPTOMIND_DB_PATH: join(SCRATCH, 'db', 'synaptomind.db'),
        SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
        SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'huggingface')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderr = ''
    const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
    child.stdout.resume()
    child.stderr.on('data', chunk => (stderr += chunk))
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000)

    try {
      const ready = await waitFor(() => stderr.includes('MCP server running in stdio mode'), 30_000)
      expect(ready, stderr).toBe(true)

      child.stdin.end()
      expect(await exited).toBe(0)
      expect(stderr).toContain('[synaptomind] process exiting with code 0')
    } finally {
      clearTimeout(killTimer)
      child.kill('SIGKILL')
    }
  }, 60_000)
})
