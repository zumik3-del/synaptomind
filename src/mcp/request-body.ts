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
// body is consumed, and an unread body keeps server.stop() waiting. Nothing in a
// rejected body is parsed, so the drain discards it: 64 KiB bounds both the
// memory a pending rejection can pin and how long a 4xx waits for an upload, and
// past the cap the stream is cancelled (Bun settles a request on the cancel).
export const DRAIN_BODY_BYTES = 65_536

export async function drainRejectedBody(request: Request): Promise<void> {
  const body = request.body
  if (!body) return
  // A declared length over the cap settles without reading a byte: the bodies
  // that reach here are never parsed, so there is nothing to wait for.
  if (Number(request.headers.get('content-length') ?? '0') > DRAIN_BODY_BYTES) {
    await body.cancel().catch(() => {})
    return
  }
  const reader = body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      received += value.byteLength
      if (received > DRAIN_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return
      }
    }
  } catch {
    // A client abort closes the stream; the request is settled either way.
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
