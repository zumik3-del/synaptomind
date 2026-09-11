import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { checkBearerAuth, getValidTokens } from '../auth'
import { rateLimitMiddleware } from '../middleware/rate-limit'
import { createMcpServer } from './server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
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
const KEEPALIVE_MS = 10_000
export const MAX_EVENTS_PER_SESSION = 1000

export class InMemoryEventStore implements EventStore {
  private events = new Map<EventId, { streamId: StreamId; message: unknown }>()

  private generateEventId(streamId: StreamId): EventId {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
  }

  async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
    const eventId = this.generateEventId(streamId)
    this.events.set(eventId, { streamId, message })
    // Bound per-session memory: Map preserves insertion order, so drop oldest first.
    while (this.events.size > MAX_EVENTS_PER_SESSION) {
      const oldest = this.events.keys().next().value
      if (oldest === undefined) break
      this.events.delete(oldest)
    }
    return eventId
  }

  async replayEventsAfter(lastEventId: EventId, { send }: { send: (eventId: EventId, message: unknown) => Promise<void> }): Promise<StreamId> {
    if (!lastEventId || !this.events.has(lastEventId)) return ''

    const streamId = this.events.get(lastEventId)!.streamId
    let found = false

    // Iterate in Map insertion order — chronological, unlike sorting id strings.
    for (const [id, { streamId: sId, message }] of this.events) {
      if (id === lastEventId) { found = true; continue }
      if (!found || sId !== streamId) continue
      await send(id, message as any)
    }
    return streamId
  }
}

async function disposePair(server: McpServer, transport: WebStandardStreamableHTTPServerTransport): Promise<void> {
  try {
    await transport.close()
  } catch { /* already closed */ }
  try {
    await server.close()
  } catch { /* already closed */ }
}

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

  app.use('/mcp', rateLimitMiddleware)

  const sessionCleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > SESSION_TTL_MS) {
        disposePair(session.server, session.transport).catch(() => {})
        sessions.delete(id)
      }
    }
  }, 60_000)

  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
      if (!session) {
        return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, 404)
      }
      session.lastAccess = Date.now()
      return session.transport.handleRequest(c.req.raw)
    }

    if (sessions.size >= MAX_SESSIONS) {
      return c.json({ error: 'Too many sessions' }, 429)
    }

    const mcpServer = createMcpServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      keepAliveMs: KEEPALIVE_MS,
      eventStore: new InMemoryEventStore(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server: mcpServer, transport, lastAccess: Date.now() })
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
      }
    })

    try {
      await mcpServer.connect(transport)
      const response = await transport.handleRequest(c.req.raw)
      // Only an initialization request registers a session; anything else
      // (e.g. a non-init request without a session id) leaves an orphan pair.
      if (!transport.sessionId || !sessions.has(transport.sessionId)) {
        await disposePair(mcpServer, transport)
      }
      return response
    } catch (err) {
      await disposePair(mcpServer, transport)
      throw err
    }
  })

  // Liveness only: no version or build/transport details for unauthenticated callers.
  app.get('/health', c => c.json({ status: 'ok' }))

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host
  })
  console.log(`[synaptomind] MCP HTTP server running on http://${host}:${port}`)

  return {
    stop() {
      clearInterval(sessionCleanup)
      for (const session of sessions.values()) {
        disposePair(session.server, session.transport).catch(() => {})
      }
      sessions.clear()
      server.stop()
    },
    getSessions() {
      return sessions
    }
  }
}
