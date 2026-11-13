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

// Bun settles a request only once its body reaches the end, so a rejected POST must be drained or
// `server.stop()` waits forever. Past the cap the stream is cancelled, which does NOT settle the
// request: 'abandoned' tells the caller to close the connection instead.
export const DRAIN_BODY_BYTES = 65_536

export type DrainOutcome = 'consumed' | 'abandoned'

export async function drainRejectedBody(request: Request): Promise<DrainOutcome> {
  const body = request.body
  if (!body) return 'consumed'
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
