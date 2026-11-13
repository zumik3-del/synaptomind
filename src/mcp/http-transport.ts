import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { getValidTokens, resolveUser, type UserRef } from '../auth'
import { config } from '../config'
import { authMiddleware } from '../middleware/auth'
import { als, getDb, getUserDb } from '../context/container'
import type { Database } from 'bun:sqlite'
import { createRateLimitMiddleware } from '../middleware/rate-limit'
import { createMcpServer } from './server'
import { disposePair } from './in-memory-event-store'
import type { Context } from 'hono'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpRouteHandler, type Session } from './mcp-route'
import {
  bodyTooLargeResponse,
  clientAbortResponse,
  drainRejectedBody,
  isClientAbort
} from './request-body'

export type { Session } from './mcp-route'

export interface McpHttpHandle {
  stop(): Promise<void>
  getSessions(): Map<string, Session>
}

interface McpHttpOptions {
  corsOrigins?: string[]
}

const MAX_SESSIONS = config.mcp.maxSessions
const SESSION_TTL_MS = config.mcp.sessionTtlMs
const KEEPALIVE_MS = config.mcp.keepAliveMs
const MAX_SUBSCRIPTIONS = config.mcp.maxSubscriptions
export const MAX_REQUEST_BODY_BYTES = 5_242_880

// Unknown errors must never surface as Hono's non-JSON 500: MCP clients parse JSON-RPC. A client
// that aborts mid-body is not a server fault, so it gets the SDK's own parse error.
export function mcpErrorHandler(err: Error, c: Context): Response {
  if (isClientAbort(err)) return clientAbortResponse()
  console.error('[synaptomind] MCP HTTP unhandled error:', err)
  return c.json(
    { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
    500
  )
}

export function startMcpHttpServer(
  host: string,
  port: number,
  options: McpHttpOptions = {}
): McpHttpHandle {
  const app = new Hono()
  const sessions = new Map<string, Session>()
  const rateLimit = createRateLimitMiddleware()

  getValidTokens()

  app.onError(mcpErrorHandler)

  // Never combine `origin: '*'` with an Authorization header: that lets any web origin drive memory.
  // Deny all cross-origin access by default; deployments opt in via mcp.corsOrigins.
  app.use(
    '*',
    cors({
      origin: options.corsOrigins ?? [],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'mcp-session-id',
        'Last-Event-ID',
        'mcp-protocol-version',
        'Mcp-Method',
        'Mcp-Name',
        'Authorization'
      ],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
    })
  )

  // Bun settles a request only when its body reaches the end, so an early rejection that leaves the
  // body unread makes server.stop() wait forever; the drain is bounded and discards the rest.
  app.use('/mcp', async (c, next) => {
    await next()
    if (c.req.method !== 'POST' || c.res.status < 400 || c.req.raw.bodyUsed) return
    const outcome = await drainRejectedBody(c.req.raw)
    if (outcome === 'abandoned') c.header('Connection', 'close')
  })

  app.use('/mcp', authMiddleware)

  const resolveRequestDb = (ref: UserRef): Database | undefined => {
    try {
      return ref.kind === 'legacy' ? getDb() : getUserDb(ref.userId)
    } catch {
      return undefined
    }
  }

  app.use('/mcp', async (c, next) => {
    const ref = resolveUser(c.req.header('Authorization'))
    if (!ref) return c.json({ error: 'Unauthorized' }, 401)

    const db = resolveRequestDb(ref)
    if (!db && ref.kind !== 'legacy')
      return new Response(JSON.stringify({ error: 'Database unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })

    ;(c as any).set('mcpUser', ref)
    return als.run({ userId: ref.userId, db: db as Database }, next)
  })

  app.use('/mcp', rateLimit)

  app.use('/mcp', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10)
    if (contentLength > MAX_REQUEST_BODY_BYTES) return bodyTooLargeResponse()
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
  sessionCleanup.unref()

  // `legacy: 'reject'` keeps a routing disagreement a protocol error, and the factory must stay
  // unmemoized: an SDK factory instance cannot serve a second request.
  const modern = createMcpHandler(() => createMcpServer(), {
    legacy: 'reject',
    keepAliveMs: KEEPALIVE_MS,
    maxSubscriptions: MAX_SUBSCRIPTIONS,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES
  })

  const route = createMcpRouteHandler({
    sessions,
    modern,
    maxSessions: MAX_SESSIONS,
    keepAliveMs: KEEPALIVE_MS,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES
  })

  app.all('/mcp', route)

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
      await Promise.allSettled([
        ...[...sessions.values()].map(session => disposePair(session.server, session.transport)),
        modern.close()
      ])
      sessions.clear()
      await server.stop()
    },
    getSessions() {
      return sessions
    }
  }
}
