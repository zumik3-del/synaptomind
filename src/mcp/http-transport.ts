import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { getValidTokens, resolveUser, type UserRef } from '../auth'
import { config } from '../config'
import { authMiddleware } from '../middleware/auth'
import { als, getDb, getUserDb } from '../db/container'
import type { Database } from 'bun:sqlite'
import { mcpRateLimitMiddleware } from '../middleware/rate-limit'
import { createMcpServer } from './server'
import { disposePair, InMemoryEventStore, probeInitializeRequest } from './in-memory-event-store'
import type { Context } from 'hono'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

export interface Session {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
  // Immutable identity of the user who created this session. Compared against
  // the re-resolved caller on every follow-up request (security: no hijack).
  userId: string
}

export interface McpHttpHandle {
  stop(): Promise<void>
  getSessions(): Map<string, Session>
}

interface McpHttpOptions {
  /** Browser origins allowed by CORS; empty (default) denies all cross-origin requests. */
  corsOrigins?: string[]
}

// Transport limits are config-driven (F16); see config.mcp.
// MAX_SESSIONS is a per-user cap: one authenticated user cannot exhaust the
// budget and get 429 for everyone else.
const MAX_SESSIONS = config.mcp.maxSessions
const SESSION_TTL_MS = config.mcp.sessionTtlMs
const KEEPALIVE_MS = config.mcp.keepAliveMs
// Mirrors the API guard in src/api/router.ts (5 MB).
export const MAX_REQUEST_BODY_BYTES = 5_242_880

// Unknown errors must never surface as Hono's default non-JSON 500: MCP clients
// parse JSON-RPC, so respond with a JSON-RPC internal-error envelope.
export function mcpErrorHandler(err: Error, c: Context): Response {
  console.error('[synaptomind] MCP HTTP unhandled error:', err)
  return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }, 500)
}

function countUserSessions(sessions: Map<string, Session>, userId: string): number {
  let count = 0
  for (const session of sessions.values()) if (session.userId === userId) count++
  return count
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

  // Per-request user binding (task #2285): re-resolve the bearer token on every
  // request and bind { userId, db } to ALS for the whole /mcp handler chain,
  // including server construction on the session-creation path. Fail-closed:
  // unknown token -> 401 (already enforced above, repeated here defensively),
  // resolved-but-unregistered user DB -> 503.
  app.use('/mcp', async (c, next) => {
    const ref = resolveUser(c.req.header('Authorization'))
    if (!ref) return c.json({ error: 'Unauthorized' }, 401)

    let db: Database | undefined
    try {
      db = ref.kind === 'legacy' ? getDb() : getUserDb(ref.userId)
    } catch {
      db = undefined
    }
    if (!db && ref.kind !== 'legacy') return new Response(JSON.stringify({ error: "Database unavailable" }), { status: 503, headers: { "content-type": "application/json" } });

    (c as any).set('mcpUser', ref)
    return als.run({ userId: ref.userId, db: db as Database }, next)
  })

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
    const ref = ((c as any).get('mcpUser') as UserRef | undefined) ?? resolveUser(c.req.header('Authorization'))
    if (!ref) return c.json({ error: 'Unauthorized' }, 401)

    let db: Database | undefined
    try {
      db = ref.kind === 'legacy' ? getDb() : getUserDb(ref.userId)
    } catch {
      db = undefined
    }
    if (!db && ref.kind !== 'legacy') return new Response(JSON.stringify({ error: "Database unavailable" }), { status: 503, headers: { "content-type": "application/json" } });

    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
      if (!session) {
        return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, 404)
      }
      // Re-resolve identity on every request: a session id alone never grants
      // access. Check before touching lastAccess so a mismatched caller cannot
      // keep the victim's session alive (and never delete the session on
      // mismatch — that would be a cross-user DoS).
      if (session.userId !== ref.userId) {
        return c.json({ jsonrpc: '2.0', error: { code: -32002, message: 'Session does not belong to the presented token' }, id: null }, 403)
      }
      session.lastAccess = Date.now()
      return trackStreamActivity(await als.run({ userId: ref.userId, db: db as Database }, () => session.transport.handleRequest(c.req.raw)), session)
    }

    // Sessionless: only an initialize request may create a session. Rejecting
    // anything else here avoids building (then immediately disposing) a full
    // McpServer + transport on every stray request (F21).
    const probe = await probeInitializeRequest(c)
    if (!probe.initialize) {
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null }, 400)
    }

    if (countUserSessions(sessions, ref.userId) >= MAX_SESSIONS) {
      return c.json({ error: 'Too many sessions' }, 429)
    }

    // Bind ALS before building the server so registration-time DB reads
    // (e.g. store.ts soft-limit description) resolve per user.
    return als.run({ userId: ref.userId, db: db as Database }, async () => {
      const mcpServer = createMcpServer()
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        keepAliveMs: KEEPALIVE_MS,
        eventStore: new InMemoryEventStore(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server: mcpServer, transport, lastAccess: Date.now(), userId: ref.userId })
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
