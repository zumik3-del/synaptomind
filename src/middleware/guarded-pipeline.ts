import type { MiddlewareHandler } from 'hono'
import { authMiddleware } from './auth'
import { MAX_REQUEST_BODY_BYTES, bodyTooLargeResponse, type ErrorShape } from './http-errors'
import { createRateLimitMiddleware } from './rate-limit'
import { bindUserContext } from './user-context'

export interface GuardedPipelineOptions {
  shape: ErrorShape
}

// Auth, user-database binding, rate limiting and the cheap body guard, in that order for both HTTP
// surfaces. The rate-limit store is deliberately per surface (one factory call each), as before:
// `/api` and `/mcp` keep separate counters. `shape` only picks the error body; see
// `createErrorHandler`.
//
// The body guard here only refuses a *declared* oversize body before anything reads it. The cap
// itself is enforced by counting the bytes as they stream in, because a chunked body declares no
// length and a `content-length` below the real size is a client lie: `/api` mounts `createBodyCap`
// right behind this pipeline, and `/mcp` counts inside its route handler, which must answer 415 for
// a non-JSON media type before it touches the body.
export function createGuardedPipeline(options: GuardedPipelineOptions): MiddlewareHandler[] {
  const declaredBodyCap: MiddlewareHandler = async (c, next) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > MAX_REQUEST_BODY_BYTES) return bodyTooLargeResponse(options.shape)
    return next()
  }

  return [authMiddleware, bindUserContext, createRateLimitMiddleware(), declaredBodyCap]
}
