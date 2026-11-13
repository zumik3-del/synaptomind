import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const INDEX_TS = resolve(import.meta.dir, 'index.ts')

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function listen(server: Server): Promise<number> {
  return new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port))
  })
}

function close(server: Server): Promise<void> {
  return new Promise(res => server.close(() => res()))
}

interface RunResult {
  code: number | null
  out: string
}

async function runServer(mcpPort: string): Promise<RunResult> {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synapto-mcpport-'))
  return new Promise((res, rej) => {
    const child = spawn('bun', ['run', INDEX_TS, '--no-embedder'], {
      cwd: SCRATCH,
      env: {
        ...process.env,
        SYNAPTOMIND_PORT: '0',
        SYNAPTOMIND_MCP_HTTP_PORT: mcpPort,
        SYNAPTOMIND_DB_PATH: join(SCRATCH, 'db', 'synaptomind.db'),
        SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
        SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'huggingface')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.once('error', rej)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 30_000)
    child.once('exit', code => {
      clearTimeout(timer)
      res({ code, out })
    })
  })
}

describe('index.ts — the MCP listener bind failure', () => {
  test('a taken MCP port fails as McpHttpPortInUseError, naming key, port and override', async () => {
    const squatter = createServer(socket => socket.destroy())
    const mcpPort = await listen(squatter)
    let res: RunResult
    try {
      res = await runServer(String(mcpPort))
    } finally {
      await close(squatter)
    }

    expect(res.code, res.out).toBe(1)
    expect(res.out).toMatch(/\[synaptomind\] API server running on http:\/\/127\.0\.0\.1:\d+/)
    expect(res.out).toContain('McpHttpPortInUseError')
    expect(res.out).toContain('mcp.httpPort')
    expect(res.out).toContain(String(mcpPort))
    expect(res.out).toContain('SYNAPTOMIND_MCP_HTTP_PORT')
    expect(res.out).toContain('The API port is unaffected by this key')
    expect(res.out).toContain('EADDRINUSE')
  }, 60_000)

  test('a non-EADDRINUSE bind failure surfaces untouched, not relabelled', async () => {
    const res = await runServer('70000')

    expect(res.code, res.out).toBe(1)
    expect(res.out).toMatch(/\[synaptomind\] API server running on http:\/\/127\.0\.0\.1:\d+/)
    expect(res.out).toContain('ERR_OUT_OF_RANGE')
    expect(res.out).toContain('out of range')
    expect(res.out).toContain('at startMcpHttpServer')
    expect(res.out).not.toContain('McpHttpPortInUseError')
    expect(res.out).not.toContain('is already in use')
  }, 60_000)
})

describe('index.ts — user database alias startup guard', () => {
  async function rejectAliases(paths: string[]): Promise<RunResult> {
    const configPath = join(SCRATCH, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        users: paths.map((dbPath, i) => ({
          id: ['alice', 'bob'][i],
          dbPath,
          tokenSha256: String(i + 1).repeat(64)
        }))
      })
    )
    return new Promise((res, rej) => {
      const child = spawn(process.execPath, ['run', INDEX_TS, '--stdio', '--no-embedder'], {
        cwd: SCRATCH,
        env: {
          PATH: process.env.PATH,
          HOME: SCRATCH,
          SYNAPTOMIND_CONFIG: configPath,
          SYNAPTOMIND_DB_PATH: join(SCRATCH, 'legacy.db'),
          SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
          SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'cache')
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let out = ''
      child.stdout.on('data', d => (out += d))
      child.stderr.on('data', d => (out += d))
      child.once('error', rej)
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.once('close', code => {
        clearTimeout(timer)
        res({ code, out })
      })
    })
  }

  test('rejects missing-file aliases before creating either user database', async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'synapto-alias-start-'))
    const target = join(SCRATCH, 'user.db')
    const result = await rejectAliases([target, `${SCRATCH}/missing/../user.db`])
    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('duplicate user dbPath')
    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(SCRATCH, 'legacy.db'))).toBe(false)
    expect(readdirSync(SCRATCH).sort()).toEqual(['.bun', 'config.json'])
  }, 15_000)

  test('rejects hard-linked user databases without changing their contents', async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'synapto-alias-start-'))
    const target = join(SCRATCH, 'one.db')
    const alias = join(SCRATCH, 'two.db')
    const contents = 'private database sentinel'
    writeFileSync(target, contents)
    linkSync(target, alias)
    const result = await rejectAliases([target, alias])
    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('duplicate user dbPath')
    expect(result.out).not.toContain(contents)
    expect(result.out).not.toContain('1'.repeat(64))
    expect(readFileSync(target, 'utf8')).toBe(contents)
    expect(readFileSync(alias, 'utf8')).toBe(contents)
    expect(readdirSync(SCRATCH).sort()).toEqual(['.bun', 'config.json', 'one.db', 'two.db'])
  }, 15_000)
})
