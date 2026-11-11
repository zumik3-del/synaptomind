import type { Database } from 'bun:sqlite'
import type { Context } from 'hono'
import {
  isJsonContentType,
  isLegacyRequest,
  type McpHttpHandler,
  type McpServer,
  WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server'
import { resolveUser, type UserRef } from '../auth'
import { als } from '../db/container'
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
  // Immutable identity of the user who created this session. Compared against
  // the re-resolved caller on every follow-up request (security: no hijack).
  userId: string
}

export interface McpRouteDeps {
  sessions: Map<string, Session>
  modern: McpHttpHandler
  /** Per-user cap on legacy sessions. */
  maxSessions: number
  keepAliveMs: number
  maxRequestBodyBytes: number
}

function countUserSessions(sessions: Map<string, Session>, userId: string): number {
  let count = 0
  for (const session of sessions.values()) if (session.userId === userId) count++
  return count
}

/**
 * Keep a session's `lastAccess` fresh while an SSE body is flowing. The SDK's
 * keep-alive frames (every {@link McpRouteDeps.keepAliveMs}) flow through the
 * body, so a long-lived GET stream stays active and the TTL sweeper cannot
 * close it (F4).
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

export function createMcpRouteHandler(deps: McpRouteDeps): (c: Context) => Promise<Response> {
  const { sessions, modern, maxSessions, keepAliveMs, maxRequestBodyBytes } = deps

  async function serveSession(
    c: Context,
    ref: UserRef,
    db: Database | undefined,
    session: Session,
    parsed: unknown
  ): Promise<Response> {
    session.lastAccess = Date.now()
    return trackStreamActivity(
      await als.run({ userId: ref.userId, db: db as Database }, () =>
        session.transport.handleRequest(c.req.raw, { parsedBody: parsed })
      ),
      session
    )
  }

  async function createSession(
    c: Context,
    ref: UserRef,
    db: Database | undefined,
    parsed: unknown
  ): Promise<Response> {
    // Only an initialize request may create a session. Rejecting anything else
    // here avoids building (then immediately disposing) a full McpServer +
    // transport on every stray request (F21).
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

    // Bind ALS before building the server so registration-time DB reads
    // (e.g. store.ts soft-limit description) resolve per user.
    return als.run({ userId: ref.userId, db: db as Database }, async () => {
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
  }

  async function serveLegacy(
    c: Context,
    ref: UserRef,
    db: Database | undefined,
    parsed: unknown
  ): Promise<Response> {
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
      if (!session) {
        return c.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
          404
        )
      }
      // Re-resolve identity on every request: a session id alone never grants
      // access. Check before touching lastAccess so a mismatched caller cannot
      // keep the victim's session alive (and never delete the session on
      // mismatch — that would be a cross-user DoS).
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
      return serveSession(c, ref, db, session, parsed)
    }

    return createSession(c, ref, db, parsed)
  }

  return async (c: Context): Promise<Response> => {
    const ref =
      ((c as any).get('mcpUser') as UserRef | undefined) ??
      resolveUser(c.req.header('Authorization'))
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

    // One bounded read + one parse serve the predicate and whichever leg runs;
    // cloning a request body that was already read would throw.
    let parsed: unknown
    if (isPost) {
      const read = await readJsonBody(c.req.raw, maxRequestBodyBytes)
      if (read.tooLarge) return bodyTooLargeResponse()
      parsed = read.body
    }

    const legacy =
      parsed === undefined ||
      (await isLegacyRequest(c.req.raw, parsed, { maxRequestBodySize: maxRequestBodyBytes }))

    if (legacy) return serveLegacy(c, ref, db, parsed)
    return modern.fetch(c.req.raw, { parsedBody: parsed })
  }
}
