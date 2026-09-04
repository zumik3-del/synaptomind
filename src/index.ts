import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { serve } from 'bun'
import { app } from './app'
import { config } from './config'
import { initDb } from './db/init'
import { startEmbedderProcess, stopEmbedderProcess } from './embedder/client'
import { closeLogDb } from './logging'
import { startMcpHttpServer } from './mcp/http-transport'
import { createMcpServer } from './mcp/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startDecayJob, stopDecayJob } from './services/decay.service'
import { startDreamerJob, stopDreamerJob } from './services/dreamer.service'
import { startGitSyncJob, stopGitSyncJob } from './services/git_sync.service'
import { startSelfImproveJob, stopSelfImproveJob } from './services/self-improve.service'
import { VERSION } from './version'

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`synaptomind v${VERSION}`)
  process.exit(0)
}

const isStdio = process.argv.includes('--stdio')

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

startEmbedderProcess().catch(err => {
  console.error(`[embedder] failed to start: ${err.message}`)
})
startDecayJob()
startDreamerJob()
startSelfImproveJob()
startGitSyncJob()

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
    stopGitSyncJob()
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
