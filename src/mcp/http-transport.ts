import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { getValidTokens } from '../auth'
import { config } from '../config'
import { createGuardedPipeline } from '../middleware/guarded-pipeline'
import { createErrorHandler, MAX_REQUEST_BODY_BYTES } from '../middleware/http-errors'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpRouteHandler, SessionRegistry, type Session } from './mcp-route'
import { drainRejectedBody } from './request-body'
import { createMcpServer } from './server'

export type { Session } from './mcp-route'
export { MAX_REQUEST_BODY_BYTES } from '../middleware/http-errors'

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

// Unknown errors must never surface as Hono's non-JSON 500: MCP clients parse JSON-RPC.
export const mcpErrorHandler = createErrorHandler('jsonrpc')

export function startMcpHttpServer(
  host: string,
  port: number,
  options: McpHttpOptions = {}
): McpHttpHandle {
  const app = new Hono()
  const registry = new SessionRegistry({
    maxSessions: MAX_SESSIONS,
    keepAliveMs: KEEPALIVE_MS,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    ttlMs: SESSION_TTL_MS
  })

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

  for (const guard of createGuardedPipeline({ shape: 'jsonrpc' })) app.use('/mcp', guard)

  const stopSweep = registry.startSweep()

  // `legacy: 'reject'` keeps a routing disagreement a protocol error, and the factory must stay
  // unmemoized: an SDK factory instance cannot serve a second request.
  const modern = createMcpHandler(() => createMcpServer(), {
    legacy: 'reject',
    keepAliveMs: KEEPALIVE_MS,
    maxSubscriptions: MAX_SUBSCRIPTIONS,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES
  })

  const route = createMcpRouteHandler({
    registry,
    modern,
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
      stopSweep()
      await Promise.allSettled([registry.disposeAll(), modern.close()])
      await server.stop()
    },
    getSessions() {
      return registry.view
    }
  }
}
