import type { McpHttpHandle } from './mcp/http-transport'
import { VERSION } from './version'

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`synaptomind v${VERSION}`)
  process.exit(0)
}

if (process.argv.slice(2)[0] === 'ops') {
  const { runCli } = await import('./cli')
  await runCli(process.argv)
  process.exit(process.exitCode ?? 0)
}

// Must stay before any server bootstrap: `embedder-process` is a side-effect module that owns the
// event loop once imported.
if (process.argv.includes('--embedder')) {
  await import('./embedder/embedder-process')
  // The import resolves while the child's own timers keep the process alive, so `process.exit(0)`
  // here would kill them and the parent would never see `ready`. Park on a promise that never settles.
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
const stdioStandalone = process.argv.includes('--stdio-standalone') || config.mcp.stdioStandalone
const ownsBackgroundJobs = !isStdio || stdioStandalone
const noEmbedder = process.argv.includes('--no-embedder') || !config.embedder.enabled

// In stdio mode stdout is the JSON-RPC channel: any console.log would corrupt the protocol stream.
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
    if ((err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
      throw new McpHttpPortInUseError(mcpPort, err)
    }
    throw err
  }

  registerShutdownSignals(async () => {
    await mcpHandle.stop()
    server.stop()
  })
}

const { installProcessHandlers } = await import('./process-handlers')
installProcessHandlers()
