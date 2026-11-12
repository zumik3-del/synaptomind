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
  /** Browser origins allowed by CORS; empty (default) denies all cross-origin requests. */
  corsOrigins?: string[]
}

// Transport limits are config-driven (F16); see config.mcp.
// MAX_SESSIONS is a per-user cap on legacy sessions: one authenticated user
// cannot exhaust the budget and get 429 for everyone else. The modern era keeps
// no session, so MAX_SUBSCRIPTIONS bounds its listen streams instead.
const MAX_SESSIONS = config.mcp.maxSessions
const SESSION_TTL_MS = config.mcp.sessionTtlMs
const KEEPALIVE_MS = config.mcp.keepAliveMs
const MAX_SUBSCRIPTIONS = config.mcp.maxSubscriptions
// Mirrors the API guard in src/api/router.ts (5 MB).
export const MAX_REQUEST_BODY_BYTES = 5_242_880

// Unknown errors must never surface as Hono's default non-JSON 500: MCP clients
// parse JSON-RPC, so respond with a JSON-RPC internal-error envelope. A client
// that aborts mid-body is not a server fault (the body read rejects while the
// socket is already gone), so answer the SDK's own parse error and log nothing.
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

  getValidTokens()

  app.onError(mcpErrorHandler)

  // Never combine `origin: '*'` with an Authorization header: that lets any web
  // origin drive memory when bearer auth is disabled. Default = deny all
  // cross-origin access; deployments opt in via mcp.corsOrigins.
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

  // Bun settles an in-flight request only once its body reaches the end; an early
  // rejection that leaves the body unread makes server.stop() wait forever. The
  // drain is bounded and discards the rest, so a rejected upload cannot buy
  // unbounded buffering or an arbitrarily late 4xx.
  app.use('/mcp', async (c, next) => {
    await next()
    if (c.req.method !== 'POST' || c.res.status < 400 || c.req.raw.bodyUsed) return
    const outcome = await drainRejectedBody(c.req.raw)
    // A cancelled body does not settle the request, so the only way to let
    // server.stop() through is to end the connection with the answer (#2464).
    if (outcome === 'abandoned') c.header('Connection', 'close')
  })

  app.use('/mcp', authMiddleware)

  // Resolve the DB handle for a resolved user ref (legacy singleton or per-user
  // DB). Returns undefined when the per-user DB is unavailable. Shared by both
  // middleware paths below (DRY).
  const resolveRequestDb = (ref: UserRef): Database | undefined => {
    try {
      return ref.kind === 'legacy' ? getDb() : getUserDb(ref.userId)
    } catch {
      return undefined
    }
  }

  // Per-request user binding (task #2285): re-resolve the bearer token on every
  // request and bind { userId, db } to ALS for the whole /mcp handler chain,
  // including server construction on the session-creation path. Fail-closed:
  // unknown token -> 401 (already enforced above, repeated here defensively),
  // resolved-but-unregistered user DB -> 503.
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

  app.use('/mcp', mcpRateLimitMiddleware)

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
  // Never hold the process open: shutdown owns the lifecycle via stop().
  sessionCleanup.unref()

  // One process-wide 2026-07-28 entry. `legacy: 'reject'` keeps a routing
  // disagreement a protocol error instead of a second serving path; the legacy
  // era is served below by the sessionful transport. The factory stays
  // unmemoized: a factory instance may not be reused by a second request.
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
      // Close every session and the modern entry before dropping the map so SSE
      // streams and their keep-alive timers are torn down deterministically.
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
