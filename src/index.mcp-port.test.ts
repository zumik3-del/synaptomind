import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
        SYNAPTOMIND_LOG_DB_PATH: join(SCRATCH, 'telemetry.db'),
        SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
        // Belt and braces: nothing may reach a model cache outside the scratch.
        SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(SCRATCH, 'huggingface'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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
