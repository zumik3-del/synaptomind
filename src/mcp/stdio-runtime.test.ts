import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Regression coverage for the MCP stdio runtime (tasks #127-#134).
//
// In stdio mode stdout is the JSON-RPC wire, so any stray log line corrupts the
// protocol. This suite boots the real entrypoint as a child process and asserts
// stdout stays pure JSON-RPC, both in the default mode (background jobs are
// delegated to the shared server) and in standalone mode (jobs owned locally).

const repoRoot = join(import.meta.dir, '..', '..')
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-runtime-test', version: '1.0.0' }
  }
}
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' }
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

const tempDirs: string[] = []

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-stdio-'))
  tempDirs.push(dir)
  return join(dir, 'test.db')
}

interface StdioRun {
  stdout: string
  stderr: string
  exitCode: number | null
}

function runStdio(extraArgs: string[] = []): Promise<StdioRun> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env } as Record<string, string | undefined>
    env.SYNAPTOMIND_DB_PATH = makeDbPath()
    env.SYNAPTOMIND_EMBEDDER_ENABLED = 'false'
    env.SYNAPTOMIND_MCP_STDIO_STANDALONE = extraArgs.includes('--stdio-standalone') ? 'true' : 'false'

    const child = spawn(process.execPath, ['src/index.ts', '--stdio', ...extraArgs], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let done = false

    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(killTimer)
      resolve({ stdout, stderr, exitCode: code })
    }

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!done) reject(new Error(`stdio child did not exit in time\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 20_000)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      // Once the tools/list response is in, close stdin so the SDK shutdown
      // path fires and the process exits on its own.
      if (!done && stdout.includes('"id":2')) child.stdin.end()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => finish(code))

    child.stdin.write(`${JSON.stringify(INIT)}\n`)
    child.stdin.write(`${JSON.stringify(INITIALIZED)}\n`)
    child.stdin.write(`${JSON.stringify(LIST)}\n`)
  })
}

function stdoutLines(stdout: string): string[] {
  return stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

function assertPureJsonRpcLines(stdout: string): void {
  const lines = stdoutLines(stdout)
  expect(lines.length).toBeGreaterThanOrEqual(2)
  for (const line of lines) {
    let parsed: { jsonrpc?: string; id?: number }
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`non-JSON line on stdout (protocol corruption): ${JSON.stringify(line)}`)
    }
    expect(parsed.jsonrpc).toBe('2.0')
  }
  // Named log prefixes must never appear on the wire.
  for (const marker of ['[synaptomind]', '[embedder]', '[ttl-cleanup]', '[search]', '[logs]']) {
    expect(stdout).not.toContain(marker)
  }
  expect(stdout).toContain('"id":1')
  expect(stdout).toContain('"id":2')
}

function toolsFrom(stdout: string): string[] {
  for (const line of stdoutLines(stdout)) {
    const parsed = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } }
    if (parsed.id === 2 && parsed.result?.tools) {
      return parsed.result.tools.map(t => t.name)
    }
  }
  return []
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('MCP stdio runtime', () => {
  test('default mode delegates background jobs and keeps stdout JSON-RPC-clean', async () => {
    const { stdout, stderr, exitCode } = await runStdio()

    expect(exitCode).toBe(0)
    assertPureJsonRpcLines(stdout)
    expect(toolsFrom(stdout).length).toBe(9)
    // Default stdio does NOT own the embedder or schedulers.
    expect(stderr).toContain('background jobs delegated to the shared server')
  }, 30_000)

  test('standalone mode (jobs owned locally) keeps stdout JSON-RPC-clean', async () => {
    const { stdout, stderr, exitCode } = await runStdio(['--stdio-standalone'])

    expect(exitCode).toBe(0)
    assertPureJsonRpcLines(stdout)
    expect(toolsFrom(stdout).length).toBe(9)
    // Standalone opts into local job ownership — no delegation message.
    expect(stderr).not.toContain('background jobs delegated to the shared server')
  }, 30_000)
})
