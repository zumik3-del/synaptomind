import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { getValidTokens } from '../auth'
import { config } from '../config'
import { authMiddleware } from '../middleware/auth'
import { mcpRateLimitMiddleware } from '../middleware/rate-limit'
import { createMcpServer } from './server'
import type { Context } from 'hono'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

interface Session {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
}

export interface McpHttpHandle {
  stop(): Promise<void>
  getSessions(): Map<string, Session>
}

export interface McpHttpOptions {
  /** Browser origins allowed by CORS; empty (default) denies all cross-origin requests. */
  corsOrigins?: string[]
}

// Transport limits are config-driven (F16); see config.mcp.
const MAX_SESSIONS = config.mcp.maxSessions
const SESSION_TTL_MS = config.mcp.sessionTtlMs
const KEEPALIVE_MS = config.mcp.keepAliveMs
export const MAX_EVENTS_PER_SESSION = config.mcp.maxEventsPerSession
// Mirrors the API guard in src/api/router.ts (5 MB).
export const MAX_REQUEST_BODY_BYTES = 5_242_880

// Unknown errors must never surface as Hono's default non-JSON 500: MCP clients
// parse JSON-RPC, so respond with a JSON-RPC internal-error envelope.
export function mcpErrorHandler(err: Error, c: Context): Response {
  console.error('[synaptomind] MCP HTTP unhandled error:', err)
  return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }, 500)
}

export interface InMemoryEventStoreOptions {
  /**
   * Invoked when a resume anchor cannot be replayed because its event was
   * evicted by the per-session cap (F10). Defaults to a console.warn so the
   * resumability loss is observable even without a custom hook.
   */
  onReplayAnchorEvicted?: (eventId: EventId) => void
}

export class InMemoryEventStore implements EventStore {
  private events = new Map<EventId, { streamId: StreamId; message: unknown }>()
  // Events dropped by the cap, so a missing anchor can be told apart from an id
  // that was never stored (a client bug rather than a resumability loss).
  private evicted = new Set<EventId>()
  private readonly onReplayAnchorEvicted?: (eventId: EventId) => void

  constructor(options: InMemoryEventStoreOptions = {}) {
    this.onReplayAnchorEvicted = options.onReplayAnchorEvicted
  }

  private generateEventId(streamId: StreamId): EventId {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
  }

  private forgetEvent(eventId: EventId): void {
    this.evicted.add(eventId)
    // Bound the tombstone set too: past the cap an evicted id is unreachable.
    while (this.evicted.size > MAX_EVENTS_PER_SESSION) {
      const oldest = this.evicted.values().next().value
      if (oldest === undefined) break
      this.evicted.delete(oldest)
    }
  }

  async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
    const eventId = this.generateEventId(streamId)
    this.events.set(eventId, { streamId, message })
    // Bound per-session memory: Map preserves insertion order, so drop oldest first.
    while (this.events.size > MAX_EVENTS_PER_SESSION) {
      const oldest = this.events.keys().next().value
      if (oldest === undefined) break
      this.events.delete(oldest)
      this.forgetEvent(oldest)
    }
    return eventId
  }

  private signalEvictedAnchor(eventId: EventId): void {
    if (this.onReplayAnchorEvicted) {
      this.onReplayAnchorEvicted(eventId)
      return
    }
    console.warn(`[synaptomind] MCP resume anchor evicted; replay unavailable: ${eventId}`)
  }

  async replayEventsAfter(lastEventId: EventId, { send }: { send: (eventId: EventId, message: unknown) => Promise<void> }): Promise<StreamId> {
    if (!lastEventId) return ''

    const anchor = this.events.get(lastEventId)
    if (!anchor) {
      // Only a known-but-evicted event is a resumability loss worth surfacing;
      // an unknown id simply has no replay.
      if (this.evicted.has(lastEventId)) this.signalEvictedAnchor(lastEventId)
      return ''
    }

    const streamId = anchor.streamId
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

/**
 * Keep a session's `lastAccess` fresh while an SSE body is flowing. The SDK's
 * keep-alive frames (every {@link KEEPALIVE_MS}) flow through the body, so a
 * long-lived GET stream stays active and the TTL sweeper cannot close it (F4).
 */
function trackStreamActivity(response: Response, session: Session): Response {
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) return response
  const tracked = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        session.lastAccess = Date.now()
        controller.enqueue(chunk)
      }
    })
  )
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function containsInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body]
  return messages.some(msg => isRecord(msg) && msg.method === 'initialize')
}

type SessionlessProbe = { initialize: true; body: unknown } | { initialize: false }

/**
 * Classify a sessionless request without building a transport: only a POST
 * carrying a JSON-RPC `initialize` message may open a session. Consumes the
 * body, so the parsed value is returned for `handleRequest({ parsedBody })`.
 */
async function probeInitializeRequest(c: Context): Promise<SessionlessProbe> {
  if (c.req.method !== 'POST') return { initialize: false }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { initialize: false }
  }
  return containsInitialize(body) ? { initialize: true, body } : { initialize: false }
}

export function startMcpHttpServer(host: string, port: number, options: McpHttpOptions = {}): McpHttpHandle {
  const app = new Hono()
  const sessions = new Map<string, Session>()

  getValidTokens()

  app.onError(mcpErrorHandler)

  // Never combine `origin: '*'` with an Authorization header: that lets any web
  // origin drive memory when bearer auth is disabled. Default = deny all
  // cross-origin access; deployments opt in via mcp.corsOrigins.
  app.use('*', cors({
    origin: options.corsOrigins ?? [],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version', 'Authorization'],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
  }))

  app.use('/mcp', authMiddleware)

  app.use('/mcp', mcpRateLimitMiddleware)

  app.use('/mcp', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10)
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Request body too large (max 5MB)' },
        id: null
      }, 413)
    }
    return next()
  })

  const sessionCleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > SESSION_TTL_MS) {
        disposePair(session.server, session.transport).catch(() => {})
        sessions.delete(id)
      }
    }
  }, 60_000)
  // Never hold the process open: shutdown owns the lifecycle via stop().
  sessionCleanup.unref()

  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
      if (!session) {
        return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, 404)
      }
      session.lastAccess = Date.now()
      return trackStreamActivity(await session.transport.handleRequest(c.req.raw), session)
    }

    // Sessionless: only an initialize request may create a session. Rejecting
    // anything else here avoids building (then immediately disposing) a full
    // McpServer + transport on every stray request (F21).
    const probe = await probeInitializeRequest(c)
    if (!probe.initialize) {
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null }, 400)
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
      const response = await transport.handleRequest(c.req.raw, { parsedBody: probe.body })
      const session = transport.sessionId ? sessions.get(transport.sessionId) : undefined
      // A request that failed to register a session must not leak its pair.
      if (!session) {
        await disposePair(mcpServer, transport)
        return response
      }
      return trackStreamActivity(response, session)
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
    async stop() {
      clearInterval(sessionCleanup)
      // Close every per-session server/transport before dropping the map so SSE
      // streams and their keep-alive timers are torn down deterministically.
      await Promise.allSettled(
        [...sessions.values()].map(session => disposePair(session.server, session.transport))
      )
      sessions.clear()
      await server.stop()
    },
    getSessions() {
      return sessions
    }
  }
}
