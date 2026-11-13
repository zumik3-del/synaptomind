import type { Database } from 'bun:sqlite'
import type { Context } from 'hono'
import {
  isJsonContentType,
  isLegacyRequest,
  type McpHttpHandler,
  type McpServer,
  WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server'
import type { UserRef } from '../auth'
import { als } from '../context/container'
import { disposePair, InMemoryEventStore } from './in-memory-event-store'
import {
  bodyTooLargeResponse,
  containsInitialize,
  readJsonBody,
  unsupportedMediaTypeResponse
} from './request-body'
import { createMcpServer } from './server'

export interface Session {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
  // Immutable owner of the session; re-checked on every follow-up request so a session id alone
  // never grants access.
  userId: string
}

export interface McpRouteDeps {
  sessions: Map<string, Session>
  modern: McpHttpHandler
  maxSessions: number
  keepAliveMs: number
  maxRequestBodyBytes: number
}

function countUserSessions(sessions: Map<string, Session>, userId: string): number {
  let count = 0
  for (const session of sessions.values()) if (session.userId === userId) count++
  return count
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
  const { sessions, modern, maxSessions, keepAliveMs, maxRequestBodyBytes } = deps

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

    if (countUserSessions(sessions, ref.userId) >= maxSessions) {
      return c.json({ error: 'Too many sessions' }, 429)
    }

    const mcpServer = createMcpServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      keepAliveMs,
      maxRequestBodySize: maxRequestBodyBytes,
      eventStore: new InMemoryEventStore(),
      onsessioninitialized: id => {
        sessions.set(id, {
          server: mcpServer,
          transport,
          lastAccess: Date.now(),
          userId: ref.userId
        })
      },
      onsessionclosed: id => {
        sessions.delete(id)
      }
    })

    try {
      await mcpServer.connect(transport)
      const response = await transport.handleRequest(c.req.raw, { parsedBody: parsed })
      const session = transport.sessionId ? sessions.get(transport.sessionId) : undefined
      if (!session) {
        await disposePair(mcpServer, transport)
        return response
      }
      return trackStreamActivity(response, session)
    } catch (err) {
      await disposePair(mcpServer, transport)
      throw err
    }
  }

  async function serveLegacy(c: Context, ref: UserRef, parsed: unknown): Promise<Response> {
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
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
    const ref: UserRef | undefined = c.get('mcpUser')
    if (!ref) return c.json({ error: 'Unauthorized' }, 401)

    const db = (als.getStore() as { db?: Database } | undefined)?.db
    if (!db && ref.kind !== 'legacy')
      return new Response(JSON.stringify({ error: 'Database unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })

    const isPost = c.req.method === 'POST'
    if (isPost && !isJsonContentType(c.req.header('content-type')))
      return unsupportedMediaTypeResponse()

    let parsed: unknown
    if (isPost) {
      const read = await readJsonBody(c.req.raw, maxRequestBodyBytes)
      if (read.tooLarge) return bodyTooLargeResponse()
      parsed = read.body
    }

    const legacy =
      parsed === undefined ||
      (await isLegacyRequest(c.req.raw, parsed, { maxRequestBodySize: maxRequestBodyBytes }))

    if (legacy) return serveLegacy(c, ref, parsed)
    return modern.fetch(c.req.raw, { parsedBody: parsed })
  }
}
