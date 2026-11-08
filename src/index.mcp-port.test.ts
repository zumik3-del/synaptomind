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

/**
 * The MCP listener's bind failure, as the OPERATOR sees it (src/index.ts:151-167).
 *
 * 2526a0b replaced the bare Bun trace on the second listener with
 * McpHttpPortInUseError, because the deploy gate can only observe a failed
 * health check on the API port — unnamed, it points the operator at the listener
 * that is working fine. The remedy is a specific config key, so the message has
 * to name the key, the port and the env override.
 *
 * The relabelling is conditional on `err.code === 'EADDRINUSE'`; a DIFFERENT
 * bind failure must reach the operator unchanged, or a real bug arrives wearing
 * a port-conflict label. Both directions are asserted here.
 *
 * Why a subprocess: src/index.ts is the entry point — its top level opens
 * listeners, inits the DB and starts schedulers, so the relabelling cannot be
 * reached by importing it. The server is therefore run as the process an
 * operator runs, with a scratch cwd (config.json is read from cwd), a scratch
 * DB, and --no-embedder. Nothing outside the per-test temp dir is written, and
 * no port is chosen by guessing: the API port is 0 (the OS picks a free one) and
 * the MCP port is held by a listener THIS PROCESS opened, so there is no
 * find-then-bind race and no chance of colliding with another agent's server.
 */

const INDEX_TS = resolve(import.meta.dir, 'index.ts')

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

/** Listen on an OS-assigned port and report it. */
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

/**
 * Run the entry point once and collect its output. The API port is left at 0 so
 * the kernel assigns a free one (the log line therefore reports the CONFIGURED
 * 0, not the bound port — what it proves is that serve() returned, since the
 * log is printed only after it); the MCP port comes from `mcpPort`, which is
 * either a squatter this test holds or a deliberately invalid value.
 */
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
        // Belt and braces: nothing may reach a model cache outside the scratch.
        SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'huggingface')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.once('error', rej)
    // An unbindable child would otherwise hang until the test budget: the
    // scenarios below always terminate, so a ceiling only bounds a regression.
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
    // A REAL squatter: this process holds the port for the whole run, so the
    // bind genuinely fails with EADDRINUSE.
    const squatter = createServer(socket => socket.destroy())
    const mcpPort = await listen(squatter)
    let res: RunResult
    try {
      res = await runServer(String(mcpPort))
    } finally {
      await close(squatter)
    }

    expect(res.code, res.out).toBe(1)
    // The failure is on the SECOND listener: serve() returned for the API one
    // (the log is printed only after it), so the message cannot be pointing the
    // operator at the listener that is working fine.
    expect(res.out).toMatch(/\[synaptomind\] API server running on http:\/\/127\.0\.0\.1:\d+/)
    // The named error, not a bare Bun trace.
    expect(res.out).toContain('McpHttpPortInUseError')
    // It names what to change...
    expect(res.out).toContain('mcp.httpPort')
    // ...which port...
    expect(res.out).toContain(String(mcpPort))
    // ...the env override that bypasses the file...
    expect(res.out).toContain('SYNAPTOMIND_MCP_HTTP_PORT')
    // ...and says the API port is not the problem, which is the whole point.
    expect(res.out).toContain('The API port is unaffected by this key')
    // The underlying cause is still attached, so the diagnosis is not lost.
    expect(res.out).toContain('EADDRINUSE')
  }, 60_000)

  test('a non-EADDRINUSE bind failure surfaces untouched, not relabelled', async () => {
    // An out-of-range port reaches the same serve() call and throws
    // ERR_OUT_OF_RANGE instead. Relabelling that as "already in use" would send
    // the operator to a port nobody is holding.
    const res = await runServer('70000')

    expect(res.code, res.out).toBe(1)
    // Still the second listener: serve() returned for the API one, so the
    // out-of-range value was only ever a problem for the MCP bind.
    expect(res.out).toMatch(/\[synaptomind\] API server running on http:\/\/127\.0\.0\.1:\d+/)
    // The original error survives, code and all.
    expect(res.out).toContain('ERR_OUT_OF_RANGE')
    expect(res.out).toContain('out of range')
    // It is still thrown from the MCP listener, so the operator can see which
    // of the two listeners failed.
    expect(res.out).toContain('at startMcpHttpServer')
    // And nothing claims it was a port conflict.
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
      // stdio mode never binds a listener, even if the guard regresses. The
      // completely scratch environment cannot inherit production overrides.
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
