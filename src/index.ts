import type { McpHttpHandle } from './mcp/http-transport'
import { VERSION } from './version'

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`synaptomind v${VERSION}\n`)
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
const { als, openDatabase } = await import('./db')
const { bootFanOut } = await import('./context/registry')
const { processOwnsBackgroundJobs } = await import('./embedder/spawn-scope')
const { createLifecycle } = await import('./lifecycle')
const { insertLog } = await import('./logging')
const { startMcpHttpServer } = await import('./mcp/http-transport')
const { createMcpServer } = await import('./mcp/server')
const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio')
const { McpHttpPortInUseError } = await import('./errors')

const isStdio = process.argv.includes('--stdio')
const ownsBackgroundJobs = processOwnsBackgroundJobs()
const embedderEnabled = !process.argv.includes('--no-embedder') && config.embedder.enabled

// In stdio mode stdout is the JSON-RPC channel: any console.log would corrupt the protocol stream.
// The logger already writes every line to stderr in that mode; this stays as a guard for libraries
// that still reach for the console.
if (isStdio) {
  console.log = console.error
  console.info = console.error
  console.debug = console.error
}

insertLog('info', 'lifecycle', `v${VERSION} — starting...`)

try {
  mkdirSync(dirname(config.db.path), { recursive: true })
} catch {}

try {
  if (isStdio && config.users.length > 0) {
    // In stdio mode owning the background jobs is exactly the standalone flag.
    if (ownsBackgroundJobs)
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
    insertLog('info', 'lifecycle', 'stdio mode: bound to legacy config.db.path')
  } else {
    const bootResult = bootFanOut()
    for (const user of bootResult.unavailable) {
      insertLog('warning', 'lifecycle', 'user database unavailable', {
        userId: user.userId,
        error: user.error
      })
    }
    insertLog('info', 'lifecycle', 'boot fan-out complete', {
      registered: bootResult.registered.length,
      unavailable: bootResult.unavailable.length
    })
  }
} catch (err) {
  insertLog('error', 'lifecycle', 'failed to init database', { error: String(err) })
  process.exit(1)
}

const lifecycle = createLifecycle({ ownsBackgroundJobs, embedderEnabled })
lifecycle.start()

let shutdownStarted = false

async function shutdown(extra?: () => void | Promise<void>): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  await lifecycle.stop(extra)
  process.exit(0)
}

function failShutdown(err: unknown): never {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  insertLog('error', 'lifecycle', `shutdown failed: ${detail}`)
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
  insertLog('info', 'lifecycle', 'MCP server running in stdio mode')
} else {
  const server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host
  })
  insertLog(
    'info',
    'lifecycle',
    `API server running on http://${config.server.host}:${config.server.port}`
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
