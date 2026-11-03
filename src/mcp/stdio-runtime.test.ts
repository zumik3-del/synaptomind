import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/init'
import { Database } from 'bun:sqlite'

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
  for (const marker of ['[synaptomind]', '[embedder]', '[search]', '[logs]']) {
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
    expect(toolsFrom(stdout).length).toBe(11)
    // Default stdio does NOT own the embedder or schedulers.
    expect(stderr).toContain('background jobs delegated to the shared server')
  }, 30_000)

  test('standalone mode (jobs owned locally) keeps stdout JSON-RPC-clean', async () => {
    const { stdout, stderr, exitCode } = await runStdio(['--stdio-standalone'])

    expect(exitCode).toBe(0)
    assertPureJsonRpcLines(stdout)
    expect(toolsFrom(stdout).length).toBe(11)
    // Standalone opts into local job ownership — no delegation message.
    expect(stderr).not.toContain('background jobs delegated to the shared server')
  }, 30_000)
})

// Exercise an actual tool call, not just tools/list: only the former accesses
// the database and checks async context propagation through the stdio SDK.
describe('stdio database boundary', () => {
  const id = '01900000-0000-7000-8000-000000000001'

  function seed(path: string, content: string) {
    const db = openDatabase({ dbPath: path, runMigrations: true })
    const now = new Date().toISOString()
    db.run('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)', ['default', 'Default', now])
    db.run('INSERT INTO thoughts (id, content, status, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, content, 'active', 'default', now, now])
    db.close(true)
  }

  function runBoundary(root: string, users: Array<{ id: string; dbPath: string }>, standalone = false): Promise<StdioRun> {
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ db: { path: join(root, 'legacy.db') }, users: users.map((u, i) => ({ ...u, tokenSha256: String(i + 1).repeat(64) })) }))
    const env = { ...process.env, SYNAPTOMIND_CONFIG: configPath, SYNAPTOMIND_DB_PATH: join(root, 'legacy.db'), SYNAPTOMIND_EMBEDDER_ENABLED: 'false', SYNAPTOMIND_MCP_STDIO_STANDALONE: standalone ? 'true' : 'false' }
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/index.ts', '--stdio'], { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`stdio timed out: ${stderr}`)) }, 20000)
      child.stdout.on('data', chunk => {
        stdout += chunk.toString()
        if (stdout.includes('"id":3')) child.stdin.end()
      })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', exitCode => { clearTimeout(timer); resolve({ stdout, stderr, exitCode }) })
      child.stdin.on('error', () => {})
      for (const msg of [INIT, INITIALIZED, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_recall', arguments: { action: 'get', thought_id: id } } }]) {
        child.stdin.write(`${JSON.stringify(msg)}\n`)
      }
    })
  }

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'synaptomind-stdio-boundary-'))
    tempDirs.push(root)
    const legacy = join(root, 'legacy.db')
    const alice = join(root, 'alice.db')
    const bob = join(root, 'bob.db')
    seed(legacy, 'legacy-only-marker')
    seed(alice, 'alice-private-marker')
    seed(bob, 'bob-private-marker')
    return { root, legacy, alice, bob }
  }

  for (const reverse of [false, true]) {
    test(`reads legacy through real stdio regardless of user order ${reverse}`, async () => {
      const f = fixture()
      const users = [{ id: 'alice', dbPath: f.alice }, { id: 'bob', dbPath: f.bob }]
      const result = await runBoundary(f.root, reverse ? users.reverse() : users)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('legacy-only-marker')
      expect(result.stdout).not.toContain('alice-private-marker')
      expect(result.stdout).not.toContain('bob-private-marker')
    }, 30000)
  }

  test('an unavailable first user never becomes a fallback to another user', async () => {
    const f = fixture()
    // A directory cannot be opened as a SQLite database but has a resolvable identity.
    const unavailable = join(f.root, 'unavailable.db')
    mkdirSync(unavailable)
    const result = await runBoundary(f.root, [{ id: 'alice', dbPath: unavailable }, { id: 'bob', dbPath: f.bob }])
    if (result.exitCode !== 0) throw new Error(`stdio failed: ${result.stderr}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('legacy-only-marker')
    expect(result.stdout).not.toContain('bob-private-marker')
  }, 30000)

  test('single-user stdio retains legacy access', async () => {
    const f = fixture()
    const result = await runBoundary(f.root, [])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('legacy-only-marker')
  }, 30000)

  test('hardlinked legacy and user databases fail closed', async () => {
    const f = fixture()
    const alias = join(f.root, 'alias.db')
    linkSync(f.legacy, alias)
    const result = await runBoundary(f.root, [{ id: 'alice', dbPath: alias }])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('cannot be safely isolated')
    expect(result.stdout).not.toContain('legacy-only-marker')
    const db = new Database(f.legacy, { readonly: true })
    expect(db.query('SELECT content FROM thoughts WHERE id = ?').get(id)).toEqual({ content: 'legacy-only-marker' })
    db.close()
  }, 30000)

  test('legacy open failure is explicit and never selects a user database', async () => {
    const f = fixture()
    rmSync(f.legacy)
    mkdirSync(f.legacy)
    const result = await runBoundary(f.root, [{ id: 'alice', dbPath: f.alice }])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('failed to init database')
    expect(result.stdout).not.toContain('alice-private-marker')
    const db = new Database(f.alice, { readonly: true })
    expect(db.query('SELECT content FROM thoughts WHERE id = ?').get(id)).toEqual({ content: 'alice-private-marker' })
    db.close()
  }, 30000)

  test('multi-user standalone refuses to start', async () => {
    const f = fixture()
    const result = await runBoundary(f.root, [{ id: 'alice', dbPath: f.alice }], true)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('stdio standalone is unavailable')
  }, 30000)
})
