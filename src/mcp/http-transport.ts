import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from 'bun'
import { getValidTokens } from '../auth'
import { config, type Config } from '../config'
import { createGuardedPipeline } from '../middleware/guarded-pipeline'
import { createErrorHandler, MAX_REQUEST_BODY_BYTES } from '../middleware/http-errors'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpRouteHandler, SessionRegistry, type Session } from './mcp-route'
import { drainRejectedBody } from './request-body'
import { createMcpServer } from './server'
import { getHealthService } from '../services/health.service'

export type { Session } from './mcp-route'
export { MAX_REQUEST_BODY_BYTES } from '../middleware/http-errors'

export interface McpHttpHandle {
  stop(): Promise<void>
  getSessions(): Map<string, Session>
}

interface McpHttpOptions {
  corsOrigins?: string[]
  /** The config the server authenticates and sizes its sessions from; the frozen global when absent. */
  config?: Config
}

// Unknown errors must never surface as Hono's non-JSON 500: MCP clients parse JSON-RPC.
export const mcpErrorHandler = createErrorHandler('jsonrpc')

// Upper bound on the graceful half of `stop()`: a request Bun still counts as in flight gets this
// long to finish before the connection is closed under it.
const STOP_DRAIN_TIMEOUT_MS = 5_000
const STOP_POLL_INTERVAL_MS = 10

export function startMcpHttpServer(
  host: string,
  port: number,
  options: McpHttpOptions = {}
): McpHttpHandle {
  const cfg = options.config ?? config
  const app = new Hono()
  const registry = new SessionRegistry({
    maxSessions: cfg.mcp.maxSessions,
    keepAliveMs: cfg.mcp.keepAliveMs,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    ttlMs: cfg.mcp.sessionTtlMs
  })

  getValidTokens(cfg)

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

  for (const guard of createGuardedPipeline({ shape: 'jsonrpc', config: options.config }))
    app.use('/mcp', guard)

  const stopSweep = registry.startSweep()

  // `legacy: 'reject'` keeps a routing disagreement a protocol error, and the factory must stay
  // unmemoized: an SDK factory instance cannot serve a second request.
  const modern = createMcpHandler(() => createMcpServer(), {
    legacy: 'reject',
    keepAliveMs: cfg.mcp.keepAliveMs,
    maxSubscriptions: cfg.mcp.maxSubscriptions,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES
  })

  const route = createMcpRouteHandler({
    registry,
    modern,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES
  })

  app.all('/mcp', route)

  app.get('/health', c => {
    const { status } = getHealthService(undefined, cfg)
    return c.json({ status }, status === 'ok' ? 200 : 503)
  })

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
      // A connection whose body Bun stopped reading keeps the graceful stop pending until the idle
      // timeout, yet `pendingRequests` already reports it as gone. Wait only for what Bun still
      // counts, then force-close the leftovers: a request past the drain deadline is abandoned too.
      const graceful = server.stop()
      const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS
      while (server.pendingRequests > 0 && Date.now() < deadline)
        await Bun.sleep(STOP_POLL_INTERVAL_MS)
      server.stop(true)
      await graceful
    },
    getSessions() {
      return registry.view
    }
  }
}
