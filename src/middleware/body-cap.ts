import type { MiddlewareHandler } from 'hono'
import { MAX_REQUEST_BODY_BYTES, bodyTooLargeResponse } from './http-errors'

// The API surface's body cap: the bytes are counted while the body streams in, so neither a chunked
// body without `content-length` nor a `content-length` that understates the real size gets past the
// limit the pipeline advertises. Reading stops as soon as the count passes the cap and the handler
// never runs; an accepted body is replayed downstream from what was already read.
//
// Only the `/api` listener mounts this, so the envelope is its JSON one. `/mcp` counts inside its
// route handler instead, because it must answer 415 for a non-JSON media type before the body is
// read and the SDK reader it delegates to already stops at the cap. One limit for both surfaces,
// two mount points; see docs/API.md.
export function createBodyCap(): MiddlewareHandler {
  return async (c, next) => {
    const request = c.req.raw
    if (!request.body) return next()
    const read = await readBoundedBody(request.body)
    if (read.tooLarge) return bodyTooLargeResponse('json')
    c.req.raw = replayBody(request, read.bytes)
    return next()
  }
}

type BoundedRead = { tooLarge: true } | { tooLarge: false; bytes: Uint8Array }

async function readBoundedBody(body: ReadableStream<Uint8Array>): Promise<BoundedRead> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      if (received > MAX_REQUEST_BODY_BYTES) return { tooLarge: true }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { tooLarge: false, bytes }
}

// The body arrives already decoded, so the replay states the real length and drops the chunked
// framing header it was sent with.
function replayBody(request: Request, bytes: Uint8Array): Request {
  const headers = new Headers(request.headers)
  headers.delete('transfer-encoding')
  headers.set('content-length', String(bytes.byteLength))
  return new Request(request, { headers, body: bytes })
}
