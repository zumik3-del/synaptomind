import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { EmbedderNotReadyError } from '../errors'

export const MAX_REQUEST_BODY_BYTES = 5_242_880

const MAX_REQUEST_BODY_MB = MAX_REQUEST_BODY_BYTES / (1024 * 1024)
const BODY_TOO_LARGE_MESSAGE = `Request body too large (max ${MAX_REQUEST_BODY_MB}MB)`

export type ErrorShape = 'json' | 'jsonrpc'

export function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })
}

export function bodyTooLargeResponse(shape: ErrorShape): Response {
  if (shape === 'jsonrpc') return jsonRpcError(413, -32000, BODY_TOO_LARGE_MESSAGE)
  return Response.json({ error: BODY_TOO_LARGE_MESSAGE }, { status: 413 })
}

function isDomainError(err: unknown): err is Error & { statusCode: ContentfulStatusCode } {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number' &&
    (err as { statusCode: number }).statusCode >= 400 &&
    (err as { statusCode: number }).statusCode < 600
  )
}

function isClientAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// The two surfaces keep different error bodies because their clients parse different things: /api
// callers read the HTTP status plus `{error}`, MCP clients parse JSON-RPC, so a non-JSON 500 would
// break them (and an aborted body is the client's parse error, not a server fault).
export function createErrorHandler(shape: ErrorShape) {
  return (err: Error, c: Context): Response => {
    if (shape === 'jsonrpc') {
      if (isClientAbort(err)) return jsonRpcError(400, -32700, 'Parse error: Invalid JSON')
      console.error('[synaptomind] MCP HTTP unhandled error:', err)
      return jsonRpcError(500, -32603, 'Internal error')
    }
    if (err instanceof EmbedderNotReadyError) {
      return c.json({ error: 'Search unavailable: model is still loading.' }, 503)
    }
    if (isDomainError(err)) {
      return c.json({ error: err.message }, err.statusCode)
    }
    console.error('[synaptomind] unhandled error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
