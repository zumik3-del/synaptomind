import type { Context } from 'hono'
import {
  isJsonContentType,
  isLegacyRequest,
  type McpHttpHandler,
  type McpServer,
  WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server'
import type { UserRef } from '../auth'
import { bodyTooLargeResponse } from '../middleware/http-errors'
import { disposePair, InMemoryEventStore } from './in-memory-event-store'
import { containsInitialize, readJsonBody, unsupportedMediaTypeResponse } from './request-body'
import { createMcpServer } from './server'

export interface Session {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
  // Immutable owner of the session; re-checked on every follow-up request so a session id alone
  // never grants access.
  userId: string
}

export interface SessionPair {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
}

export interface SessionRegistryOptions {
  maxSessions: number
  keepAliveMs: number
  maxRequestBodyBytes: number
  ttlMs: number
}

// Sessions live in this one process: an id issued by one instance is unknown to another, so the
// HTTP transport must run single-instance. Scaling out needs sticky routing (or a shared session
// store and transport lookup), not another replica behind a plain round-robin.
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>()
  private readonly options: SessionRegistryOptions

  constructor(options: SessionRegistryOptions) {
    this.options = options
  }

  /** Live sessions keyed by id, for the transport handle's `getSessions()` and its tests. */
  get view(): Map<string, Session> {
    return this.sessions
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  countForUser(userId: string): number {
    let count = 0
    for (const session of this.sessions.values()) if (session.userId === userId) count++
    return count
  }

  atCapacity(userId: string): boolean {
    return this.countForUser(userId) >= this.options.maxSessions
  }

  /** Builds the server/transport pair; the session registers itself when the transport issues an id. */
  create(ref: UserRef): SessionPair {
    const server = createMcpServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      keepAliveMs: this.options.keepAliveMs,
      maxRequestBodySize: this.options.maxRequestBodyBytes,
      eventStore: new InMemoryEventStore(),
      onsessioninitialized: id => {
        this.sessions.set(id, { server, transport, lastAccess: Date.now(), userId: ref.userId })
      },
      onsessionclosed: id => {
        this.sessions.delete(id)
      }
    })
    return { server, transport }
  }

  async dispose(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await disposePair(session.server, session.transport)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map(id => this.dispose(id)))
    this.sessions.clear()
  }

  sweep(now: number = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccess > this.options.ttlMs) void this.dispose(id)
    }
  }

  startSweep(intervalMs = 60_000): () => void {
    const timer = setInterval(() => this.sweep(), intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }
}

export interface McpRouteDeps {
  registry: SessionRegistry
  modern: McpHttpHandler
  maxRequestBodyBytes: number
}

// SSE bodies carry the SDK's keep-alive frames, so touching `lastAccess` per chunk is what keeps a
// long-lived GET stream from being reclaimed by the TTL sweeper.
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

export function createMcpRouteHandler(deps: McpRouteDeps): (c: Context) => Promise<Response> {
  const { registry, modern, maxRequestBodyBytes } = deps

  async function serveSession(c: Context, session: Session, parsed: unknown): Promise<Response> {
    session.lastAccess = Date.now()
    return trackStreamActivity(
      await session.transport.handleRequest(c.req.raw, { parsedBody: parsed }),
      session
    )
  }

  async function createSession(c: Context, ref: UserRef, parsed: unknown): Promise<Response> {
    if (!containsInitialize(parsed)) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
          id: null
        },
        400
      )
    }

    if (registry.atCapacity(ref.userId)) {
      return c.json({ error: 'Too many sessions' }, 429)
    }

    const pair = registry.create(ref)
    try {
      await pair.server.connect(pair.transport)
      const response = await pair.transport.handleRequest(c.req.raw, { parsedBody: parsed })
      const session = pair.transport.sessionId ? registry.get(pair.transport.sessionId) : undefined
      if (!session) {
        await disposePair(pair.server, pair.transport)
        return response
      }
      return trackStreamActivity(response, session)
    } catch (err) {
      await disposePair(pair.server, pair.transport)
      throw err
    }
  }

  async function serveLegacy(c: Context, ref: UserRef, parsed: unknown): Promise<Response> {
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = registry.get(sessionId)
      if (!session) {
        return c.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
          404
        )
      }
      // Checked before `lastAccess`: a mismatched caller must not keep the victim's session alive,
      // and the session is NOT deleted on mismatch (that would be a cross-user DoS).
      if (session.userId !== ref.userId) {
        return c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32002, message: 'Session does not belong to the presented token' },
            id: null
          },
          403
        )
      }
      return serveSession(c, session, parsed)
    }

    return createSession(c, ref, parsed)
  }

  return async (c: Context): Promise<Response> => {
    const ref = c.get('mcpUser')
    if (!ref) return c.json({ error: 'Unauthorized' }, 401)

    const isPost = c.req.method === 'POST'
    if (isPost && !isJsonContentType(c.req.header('content-type')))
      return unsupportedMediaTypeResponse()

    let parsed: unknown
    if (isPost) {
      const read = await readJsonBody(c.req.raw, maxRequestBodyBytes)
      if (read.tooLarge) return bodyTooLargeResponse('jsonrpc')
      parsed = read.body
    }

    const legacy =
      parsed === undefined ||
      (await isLegacyRequest(c.req.raw, parsed, { maxRequestBodySize: maxRequestBodyBytes }))

    if (legacy) return serveLegacy(c, ref, parsed)
    return modern.fetch(c.req.raw, { parsedBody: parsed })
  }
}
