import { VERSION } from './version'

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`synaptomind v${VERSION}`)
  process.exit(0)
}

const { mkdirSync } = await import('fs')
const { dirname } = await import('path')
const { serve } = await import('bun')
const { app } = await import('./app')
const { config } = await import('./config')
const { initDb } = await import('./db/init')
const { startEmbedderProcess, stopEmbedderProcess } = await import('./embedder/client')
const { closeLogDb } = await import('./logging')
const { startMcpHttpServer } = await import('./mcp/http-transport')
const { createMcpServer } = await import('./mcp/server')
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
const { startDecayJob, stopDecayJob } = await import('./services/decay.service')
const { startDreamerJob, stopDreamerJob } = await import('./services/dreamer.service')
const { startSelfImproveJob, stopSelfImproveJob } = await import('./services/self-improve.service')
const { startTtlCleanupJob, stopTtlCleanupJob } = await import('./services/ttl-cleanup.service')

const isStdio = process.argv.includes('--stdio')
// Single-owner default: a stdio MCP client must not spawn its own embedder and
// background schedulers against the shared DB — those belong to the standalone
// HTTP server. Opt into local ownership explicitly via flag or env when running
// stdio without a shared server.
const stdioStandalone =
  process.argv.includes('--stdio-standalone') || config.mcp.stdioStandalone
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

try {
  initDb({ runMigrations: true })
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
  startDreamerJob()
  startSelfImproveJob()
  startTtlCleanupJob()
}

let shutdownStarted = false

async function shutdown(extra?: () => void | Promise<void>): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  console.error('\n[synaptomind] shutting down...')
  stopDecayJob()
  stopDreamerJob()
  stopSelfImproveJob()
  stopTtlCleanupJob()
  await stopEmbedderProcess()
  closeLogDb()
  if (extra) await extra()
  process.exit(0)
}

function registerShutdownSignals(extra?: () => void | Promise<void>): void {
  const handler = (): void => {
    void shutdown(extra)
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
    void shutdown()
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
  console.log(`[synaptomind] API server running on http://${config.server.host}:${config.server.port}`)

  const mcpPort = config.mcp?.httpPort ?? 3006
  const mcpHandle = startMcpHttpServer(config.server.host, mcpPort, {
    corsOrigins: config.mcp.corsOrigins
  })

  registerShutdownSignals(async () => {
    // stop() closes every per-session server/transport before clearing the
    // session Map, then stops the HTTP listener. Await it so shutdown is
    // graceful rather than best-effort.
    await mcpHandle.stop()
    server.stop()
  })
}
