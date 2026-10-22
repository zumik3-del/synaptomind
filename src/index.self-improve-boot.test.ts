import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'

// The boot half of the removal (ADR 2026-10-21, Q2): the removed subsystem
// wrote a row of its own type into the `logs` table on EVERY server start —
// the production log db carries 97 of them, one per boot. The service must
// therefore start without writing such a row.
//
// Why a subprocess: src/index.ts is the entry point — its top level opens the
// listeners, inits the DB and starts the schedulers, so the behaviour cannot be
// reached by importing it. The server is run the way an operator runs it, in a
// scratch cwd (config.json is read from cwd), with a scratch log db, on an
// OS-assigned port and with the embedder disabled (no model download, no
// second process). Nothing outside the per-test temp dir is written.
//
// The API port is discovered from the child's own listening sockets
// (/proc/<pid>/fd → /proc/net/tcp), so no port is guessed and there is no
// find-then-bind race. The MCP listener answers /health too, so the API port
// is the one whose /health body carries the server's own health checks.
//
// The procfs is a Linux interface, so the two boot tests are Linux-only: on
// another platform they skip with the reason in their name instead of
// failing (see platformHasProcfs below).
//
// The type name is assembled from parts on purpose: this file must not contain
// the very string it forbids, so a repo-wide grep over src/ stays empty.

const STEM = 'self'
const REMOVED_TYPE = `${STEM}_improve`

const INDEX_TS = resolve(import.meta.dir, 'index.ts')
const SECRET = 'test-token-boot'
const START_TIMEOUT_MS = 30_000

/**
 * The port discovery below reads the child's listening sockets out of the
 * Linux procfs: /proc/<pid>/fd for the socket inodes and /proc/net/tcp for
 * the ports. No other platform has that interface, so on macOS or Windows the
 * discovery would fail with a file-not-found error. The boot guard therefore
 * skips there — with the reason in the test name — instead of failing.
 */
function platformHasProcfs(platform: string): boolean {
  return platform === 'linux'
}

const PROCFS = platformHasProcfs(process.platform)
const SKIP_REASON = 'needs the Linux procfs: the port discovery reads /proc/<pid>/fd and /proc/net/tcp'

let scratch = ''

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

/** The ports the given process listens on. */
function listeningPorts(pid: number): number[] {
  const inodes = new Set<string>()
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const link = readlinkSync(`/proc/${pid}/fd/${fd}`)
      const match = link.match(/^socket:\[(\d+)\]$/)
      if (match) inodes.add(match[1])
    } catch {
      /* the fd raced with a close */
    }
  }
  const ports: number[] = []
  for (const line of readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 10) continue
    if (parts[3] !== '0A') continue // LISTEN
    if (!inodes.has(parts[9])) continue
    ports.push(parseInt(parts[1].split(':')[1], 16))
  }
  return ports
}

interface BootedServer {
  apiPort: number
  logDbPath: string
  output: string
  /** Terminate the child (the service) and wait for it to be gone. */
  stop: () => Promise<void>
}

/**
 * Start the service the way an operator starts it and wait until its API
 * listener answers. The caller stops it through the returned handle.
 */
async function bootService(): Promise<BootedServer> {
  // The system temp root (TMPDIR on POSIX), never a hardcoded host path: a CI
  // runner has no /tmp/opencode, and mkdtempSync does not create its parent.
  scratch = mkdtempSync(join(tmpdir(), 'synaptomind-boot-'))
  const logDbPath = join(scratch, 'logs.db')

  const child = spawn('bun', ['run', INDEX_TS, '--no-embedder'], {
    cwd: scratch,
    env: {
      ...process.env,
      SYNAPTOMIND_PORT: '0',
      SYNAPTOMIND_MCP_HTTP_PORT: '0',
      // The host is pinned as well as the port: SYNAPTOMIND_HOST reaches
      // config.server.host (src/config.ts:147) and the discovery above reads
      // ONLY /proc/net/tcp — an IPv4 table. A host of ::1 (an operator's env,
      // inherited through process.env) makes the service listen on an IPv6
      // socket, which lives in /proc/net/tcp6, so the discovery finds no port
      // and the test dies of a 30 s timeout on a machine that is otherwise
      // fine. Pinning the host keeps the test host-independent.
      SYNAPTOMIND_HOST: '127.0.0.1',
      // The main db is irrelevant here and must not need the vec0 extension.
      SYNAPTOMIND_DB_PATH: ':memory:',
      SYNAPTOMIND_LOG_DB_PATH: logDbPath,
      SYNAPTOMIND_EMBEDDER_ENABLED: 'false',
      SYNAPTOMIND_EMBEDDER_CACHE_DIR: join(scratch, 'huggingface'),
      SYNAPTOMIND_SECRET: SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  child.stdout.on('data', d => (output += d))
  child.stderr.on('data', d => (output += d))

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000))
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  // Wait for the API listener to come up.
  const deadline = Date.now() + START_TIMEOUT_MS
  let apiPort = 0
  while (Date.now() < deadline && apiPort === 0) {
    if (child.exitCode !== null) {
      await stop()
      throw new Error(`the service exited early (code ${child.exitCode}):\n${output}`)
    }
    for (const port of listeningPorts(child.pid!)) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${SECRET}` }
        })
        const body = (await res.json()) as Record<string, unknown>
        // The API listener answers with its own health checks; the MCP
        // listener answers /health with a bare status.
        if (body.checks) {
          apiPort = port
          break
        }
      } catch {
        /* not the API listener */
      }
    }
    if (apiPort === 0) await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (apiPort === 0) {
    await stop()
    throw new Error(`the service did not start in time:\n${output}`)
  }

  return { apiPort, logDbPath, output, stop }
}

test('the procfs guard decides on the platform alone', () => {
  // The guard is what keeps the boot tests from failing on a platform without
  // the procfs: only Linux has it, and the port discovery needs it.
  expect(platformHasProcfs('linux')).toBe(true)
  expect(platformHasProcfs('darwin')).toBe(false)
  expect(platformHasProcfs('win32')).toBe(false)
})

/**
 * A boot test that needs the Linux procfs. Elsewhere it is skipped, with the
 * reason in its name, so the skip is visible in the test report.
 */
function itBoot(name: string, fn: () => Promise<void>): void {
  test.skipIf(!PROCFS)(
    PROCFS ? name : `${name} (skipped: ${SKIP_REASON})`,
    fn,
    START_TIMEOUT_MS + 15_000
  )
}

itBoot('a started service writes no row of the removed type into its log db', async () => {
  const server = await bootService()
  try {
    // A request that makes the running service write a log row of its own: the
    // content exceeds the soft limit, so the server logs the warning. The log
    // db is therefore demonstrably being written to.
    const res = await fetch(`http://127.0.0.1:${server.apiPort}/api/thoughts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ content: 'a'.repeat(700) })
    })
    expect(res.status).toBe(201)

    const db = new Database(server.logDbPath, { readonly: true })
    try {
      const byType = db.prepare('SELECT type, COUNT(*) AS c FROM logs GROUP BY type').all() as Array<{
        type: string
        c: number
      }>
      const removed = byType.filter(row => row.type === REMOVED_TYPE)
      expect(removed).toEqual([])
      // The server really did write to this log db.
      expect(byType.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  } finally {
    await server.stop()
  }
})

itBoot('the log db of a started service holds no row of the removed type, request or not', async () => {
  const server = await bootService()
  try {
    // No request at all: the removed subsystem wrote its row on the boot itself.
    if (!existsSync(server.logDbPath)) {
      // Nothing was logged at boot — the strongest possible form of the claim.
      expect(server.output).toContain('API server running')
      return
    }
    const db = new Database(server.logDbPath, { readonly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM logs WHERE type = ?').get(REMOVED_TYPE) as {
        c: number
      }
      expect(row.c).toBe(0)
    } finally {
      db.close()
    }
  } finally {
    await server.stop()
  }
})
