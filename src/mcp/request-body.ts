import { readRequestBody } from '@modelcontextprotocol/server'

export type BoundedJsonBody = { tooLarge: true } | { tooLarge: false; body: unknown }

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })
}

export function bodyTooLargeResponse(): Response {
  return jsonRpcError(413, -32000, 'Request body too large (max 5MB)')
}

export function unsupportedMediaTypeResponse(): Response {
  return jsonRpcError(415, -32000, 'Unsupported Media Type: Content-Type must be application/json')
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function containsInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body]
  return messages.some(msg => isRecord(msg) && msg.method === 'initialize')
}
