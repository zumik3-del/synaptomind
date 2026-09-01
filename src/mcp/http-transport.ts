import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { checkBearerAuth, getValidTokens } from '../auth'
import { createMcpServer } from './server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

interface Session {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
}

export interface McpHttpHandle {
  stop(): void
  getSessions(): Map<string, Session>
}

const MAX_SESSIONS = 100
const SESSION_TTL_MS = 3600_000

export function startMcpHttpServer(host: string, port: number): McpHttpHandle {
  const app = new Hono()
  const sessions = new Map<string, Session>()

  getValidTokens()

  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version', 'Authorization'],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
  }))

  app.use('/mcp', async (c, next) => {
    const auth = c.req.header('Authorization')
    if (checkBearerAuth(auth)) return next()
    return c.json({ error: 'Unauthorized' }, 401)
  })

  const sessionCleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > SESSION_TTL_MS) {
        session.transport.close().catch(() => {})
        sessions.delete(id)
      }
    }
  }, 60_000)

  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
      if (session) {
        session.lastAccess = Date.now()
        return session.transport.handleRequest(c.req.raw)
      }
    }

    if (sessions.size >= MAX_SESSIONS) {
      return c.json({ error: 'Too many sessions' }, 429)
    }

    const mcpServer = createMcpServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server: mcpServer, transport, lastAccess: Date.now() })
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
      }
    })

    await mcpServer.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  app.get('/health', c => c.json({ status: 'ok', transport: 'mcp-http' }))

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host
  })
  console.log(`[synaptomind] MCP HTTP server running on http://${host}:${port}`)

  return {
    stop() {
      clearInterval(sessionCleanup)
      server.stop()
    },
    getSessions() {
      return sessions
    }
  }
}
