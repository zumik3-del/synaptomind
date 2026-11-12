import { readRequestBody } from '@modelcontextprotocol/server'

export type BoundedJsonBody = { tooLarge: true } | { tooLarge: false; body: unknown }

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })
}

export function bodyTooLargeResponse(): Response {
  return jsonRpcError(413, -32000, 'Request body too large (max 5MB)')
}

export function clientAbortResponse(): Response {
  return jsonRpcError(400, -32700, 'Parse error: Invalid JSON')
}

export function unsupportedMediaTypeResponse(): Response {
  return jsonRpcError(415, -32000, 'Unsupported Media Type: Content-Type must be application/json')
}

export function isClientAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// Mirrors the MCP entry's own parse rule: empty or invalid JSON is `undefined`,
// which the entry classifies as legacy; a literal `null` is a parsed body.
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<BoundedJsonBody> {
  const read = await readRequestBody(request, maxBytes)
  if (read.tooLarge) return { tooLarge: true }
  return { tooLarge: false, body: parseJsonOrUndefined(read.text) }
}

// A rejected POST still has to be drained: Bun settles a request only once its
// body reaches the end, and an unread body keeps server.stop() waiting. Nothing
// in a rejected body is parsed, so the drain discards it: 64 KiB bounds both the
// memory a pending rejection can pin and how long a 4xx waits for an upload.
//
// Past the cap the stream is cancelled, which does NOT settle the request even
// though the cancel itself resolves: Bun writes the 4xx and keeps the connection
// in flight with the rest of the body unread, so a client that still has bytes to
// send (the ordinary oversized-upload shape) leaves server.stop() waiting
// forever. 'abandoned' reports exactly that, and the caller has to close the
// connection instead (#2464).
export const DRAIN_BODY_BYTES = 65_536

export type DrainOutcome = 'consumed' | 'abandoned'

export async function drainRejectedBody(request: Request): Promise<DrainOutcome> {
  const body = request.body
  if (!body) return 'consumed'
  // A declared length over the cap stops before reading a byte: the bodies that
  // reach here are never parsed, so there is nothing to wait for.
  if (Number(request.headers.get('content-length') ?? '0') > DRAIN_BODY_BYTES) {
    await body.cancel().catch(() => {})
    return 'abandoned'
  }
  const reader = body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return 'consumed'
      received += value.byteLength
      if (received > DRAIN_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return 'abandoned'
      }
    }
  } catch {
    // A client abort closes the stream, and the request is settled with it.
    return 'consumed'
  } finally {
    reader.releaseLock()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function containsInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body]
  return messages.some(msg => isRecord(msg) && msg.method === 'initialize')
}
