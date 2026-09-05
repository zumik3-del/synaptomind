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

const isStdio = process.argv.includes('--stdio')
const noEmbedder = process.argv.includes('--no-embedder') || !config.embedder.enabled

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

if (isStdio) {
  const mcpServer = createMcpServer()
  const transport = new StdioServerTransport()
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
  const mcpHandle = startMcpHttpServer(config.server.host, mcpPort)

  async function shutdown() {
    console.log('\n[synaptomind] shutting down...')
    stopDecayJob()
    stopDreamerJob()
    stopSelfImproveJob()
    await stopEmbedderProcess()
    closeLogDb()
    const sessions = mcpHandle.getSessions()
    for (const [, session] of sessions) {
      await session.transport.close()
    }
    sessions.clear()
    mcpHandle.stop()
    server.stop()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
