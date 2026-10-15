// Extracted from src/mcp/http-transport.ts (architectural audit, ziptask #1578):
// the event store plus the session-lifecycle helpers it was bundled with.
import { config } from '../config'
import type { Context } from 'hono'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

// The per-session event cap is config-driven (F16); it lives with the store that
// enforces it.
export const MAX_EVENTS_PER_SESSION = config.mcp.maxEventsPerSession

interface InMemoryEventStoreOptions {
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

export async function disposePair(server: McpServer, transport: WebStandardStreamableHTTPServerTransport): Promise<void> {
  try {
    await transport.close()
  } catch { /* already closed */ }
  try {
    await server.close()
  } catch { /* already closed */ }
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
export async function probeInitializeRequest(c: Context): Promise<SessionlessProbe> {
  if (c.req.method !== 'POST') return { initialize: false }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { initialize: false }
  }
  return containsInitialize(body) ? { initialize: true, body } : { initialize: false }
}
