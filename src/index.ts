import type { McpHttpHandle } from './mcp/http-transport'
import { VERSION } from './version'

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`synaptomind v${VERSION}`)
  process.exit(0)
}

// CLI subcommands: `synaptomind ops health-check ...`
if (process.argv.slice(2)[0] === 'ops') {
  const { runCli } = await import('./cli')
  await runCli(process.argv)
  process.exit(process.exitCode ?? 0)
}

// Embedder self-mode (ADR 0001 §2.4): a compiled binary spawns itself with this
// flag, so one artifact serves both roles. Checked after --version and before
// any server bootstrap — embedder-process.ts is a side-effect module (initDb,
// model validation, worker, IPC) that owns the event loop once imported, so no
// port may be opened and no scheduler started before this branch.
if (process.argv.includes('--embedder')) {
  await import('./embedder/embedder-process')
  // The import RESOLVES: a module's top-level evaluation ends at
  // process.send?.({ type: 'ready' }) (src/embedder/embedder-process.ts:200), so
  // control comes back here even though the module just installed the poll,
  // sweep and idle timers that keep this process alive. The ADR's trailing
  // process.exit(0) therefore killed the very timers that owned the event loop
  // — the child exited immediately with code 0, the parent never saw `ready`,
  // and /health stayed "embedder":"not ready" forever. (Source mode never
  // showed this: there the file is the entry point, so it never returns.)
  //
  // Park on a promise that never settles instead of exiting. The branch can no
  // longer fall through into the server bootstrap, and only the module's own
  // idle timeout or a parent `shutdown` message ends the process — both call
  // process.exit themselves.
  await new Promise<never>(() => {})
}

const { mkdirSync } = await import('fs')
const { dirname, isAbsolute } = await import('path')
const { serve } = await import('bun')
const { app } = await import('./app')
const { config } = await import('./config')
const { closeDb, openDatabase } = await import('./db/init')
const { als, bootFanOut } = await import('./context/registry')
const { startEmbedderProcess, stopEmbedderProcess } = await import('./embedder/client')
const { closeLogging } = await import('./logging')
const { startMcpHttpServer } = await import('./mcp/http-transport')
const { createMcpServer } = await import('./mcp/server')
const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio')
const { McpHttpPortInUseError } = await import('./errors')
const { startDecayJob, stopDecayJob } = await import('./services/decay.service')
const { startPlacementRetentionJob, stopPlacementRetentionJob } = await import(
  './services/placement-retention.service'
)

const isStdio = process.argv.includes('--stdio')
// Single-owner default: a stdio MCP client must not spawn its own embedder and
// background schedulers against the shared DB — those belong to the standalone
// HTTP server. Opt into local ownership explicitly via flag or env when running
// stdio without a shared server.
const stdioStandalone = process.argv.includes('--stdio-standalone') || config.mcp.stdioStandalone
const ownsBackgroundJobs = !isStdio || stdioStandalone
const noEmbedder = process.argv.includes('--no-embedder') || !config.embedder.enabled

// In stdio mode stdout is the JSON-RPC channel. Route the console's stdout
// writers (log/info/debug) to stderr so no background code can corrupt the
// protocol stream. console.warn/error already target stderr.
if (isStdio) {
  console.log = console.error
  console.info = console.error
  console.debug = console.error
}

console.error(`[synaptomind] v${VERSION} — starting...`)

try {
  mkdirSync(dirname(config.db.path), { recursive: true })
} catch {}

let bootResult:
  | { registered: string[]; unavailable: Array<{ userId: string; error: string }> }
  | undefined
try {
  if (isStdio && config.users.length > 0) {
    // Multi-user background workers operate on user databases, not the legacy
    // stdio database. Do not start them under this unauthenticated transport.
    if (stdioStandalone)
      throw new Error('stdio standalone is unavailable with multi-user configuration')
    if (config.db.path !== ':memory:') {
      const { assertDistinctDatabasePaths } = await import('./config.db-identity')
      const legacyPath = isAbsolute(config.db.path)
        ? config.db.path
        : `${process.cwd()}/${config.db.path}`
      try {
        assertDistinctDatabasePaths([legacyPath, ...config.users.map(user => user.dbPath)])
      } catch (err) {
        throw new Error(
          `stdio legacy database cannot be safely isolated from user databases: ${err}`
        )
      }
    }
    const db = openDatabase({ dbPath: config.db.path, runMigrations: true })
    als.enterWith({ userId: 'stdio-legacy', db })
    console.error('[synaptomind] stdio mode: bound to legacy config.db.path')
  } else {
    bootResult = bootFanOut()
    if (bootResult.unavailable.length > 0) {
      for (const u of bootResult.unavailable) {
        console.error(`[synaptomind] user ${u.userId} is unavailable: ${u.error}`)
      }
    }
    console.error(
      `[synaptomind] boot fan-out complete: ${bootResult.registered.length} registered, ${bootResult.unavailable.length} unavailable`
    )
  }
} catch (err) {
  console.error(`[synaptomind] failed to init database: ${err}`)
  process.exit(1)
}

if (!ownsBackgroundJobs) {
  console.error(
    '[synaptomind] stdio mode: embedder and background jobs delegated to the shared server ' +
      '(set SYNAPTOMIND_MCP_STDIO_STANDALONE=true or pass --stdio-standalone to run them locally)'
  )
} else {
  if (noEmbedder) {
    console.error('[synaptomind] embedder disabled (--no-embedder or embedder.enabled=false)')
  } else {
    startEmbedderProcess().catch(err => {
      console.error(`[embedder] failed to start: ${err.message}`)
    })
  }
  startDecayJob()
  startPlacementRetentionJob()
}

let shutdownStarted = false

async function shutdown(extra?: () => void | Promise<void>): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  console.error('\n[synaptomind] shutting down...')
  stopDecayJob()
  stopPlacementRetentionJob()
  await stopEmbedderProcess()
  closeLogging()
  if (extra) await extra()
  try {
    const { clearRegistry, listUserDatabases } = await import('./context/registry')
    for (const { db } of listUserDatabases()) {
      try {
        db.close(true)
      } catch {}
    }
    clearRegistry()
  } catch {}
  closeDb()
  process.exit(0)
}

function failShutdown(err: unknown): never {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[synaptomind] shutdown failed: ${detail}`)
  process.exit(1)
}

function registerShutdownSignals(extra?: () => void | Promise<void>): void {
  const handler = (): void => {
    shutdown(extra).catch(failShutdown)
  }
  process.on('SIGTERM', handler)
  process.on('SIGINT', handler)
}

if (isStdio) {
  const mcpServer = createMcpServer()
  const transport = new StdioServerTransport()

  // A stdio MCP client disconnects by closing our stdin; the SDK transport
  // does not surface that, so trigger the shared shutdown ourselves.
  const onDisconnect = (): void => {
    shutdown().catch(failShutdown)
  }
  process.stdin.on('end', onDisconnect)
  process.stdin.on('close', onDisconnect)
  mcpServer.server.onclose = onDisconnect
  registerShutdownSignals()

  await mcpServer.connect(transport)
  console.error('[synaptomind] MCP server running in stdio mode')
} else {
  const server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host
  })
  console.log(
    `[synaptomind] API server running on http://${config.server.host}:${config.server.port}`
  )

  const mcpPort = config.mcp?.httpPort ?? 3006
  let mcpHandle: McpHttpHandle
  try {
    mcpHandle = startMcpHttpServer(config.server.host, mcpPort, {
      corsOrigins: config.mcp.corsOrigins
    })
  } catch (err) {
    // serve() throws EADDRINUSE on a taken port. Unnamed, that surfaces as a
    // bare Bun stack trace and the deploy gate reports a failed health check on
    // the API port — sending the operator to the listener that is actually fine
    // (task #1077). Name the key and the port instead; anything else is rethrown
    // untouched so a real bug is not relabelled.
    if ((err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
      throw new McpHttpPortInUseError(mcpPort, err)
    }
    throw err
  }

  registerShutdownSignals(async () => {
    // stop() closes every per-session server/transport before clearing the
    // session Map, then stops the HTTP listener. Await it so shutdown is
    // graceful rather than best-effort.
    await mcpHandle.stop()
    server.stop()
  })
}

const { installProcessHandlers } = await import('./process-handlers')
installProcessHandlers()
