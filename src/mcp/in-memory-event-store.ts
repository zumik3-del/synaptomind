import { config } from '../config'
import type {
  McpServer,
  EventStore,
  StreamId,
  EventId,
  WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server'

export const MAX_EVENTS_PER_SESSION = config.mcp.maxEventsPerSession

interface InMemoryEventStoreOptions {
  onReplayAnchorEvicted?: (eventId: EventId) => void
}

export class InMemoryEventStore implements EventStore {
  private events = new Map<EventId, { streamId: StreamId; message: unknown }>()
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
    while (this.evicted.size > MAX_EVENTS_PER_SESSION) {
      const oldest = this.evicted.values().next().value
      if (oldest === undefined) break
      this.evicted.delete(oldest)
    }
  }

  async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
    const eventId = this.generateEventId(streamId)
    this.events.set(eventId, { streamId, message })
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

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: unknown) => Promise<void> }
  ): Promise<StreamId> {
    if (!lastEventId) return ''

    const anchor = this.events.get(lastEventId)
    if (!anchor) {
      if (this.evicted.has(lastEventId)) this.signalEvictedAnchor(lastEventId)
      return ''
    }

    const streamId = anchor.streamId
    let found = false

    for (const [id, { streamId: sId, message }] of this.events) {
      if (id === lastEventId) {
        found = true
        continue
      }
      if (!found || sId !== streamId) continue
      await send(id, message)
    }
    return streamId
  }
}

export async function disposePair(
  server: McpServer,
  transport: WebStandardStreamableHTTPServerTransport
): Promise<void> {
  try {
    await transport.close()
  } catch {}
  try {
    await server.close()
  } catch {}
}
