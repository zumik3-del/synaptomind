import type { MiddlewareHandler } from 'hono'
import { authMiddleware } from './auth'
import { MAX_REQUEST_BODY_BYTES, bodyTooLargeResponse, type ErrorShape } from './http-errors'
import { createRateLimitMiddleware } from './rate-limit'
import { bindUserContext } from './user-context'

export interface GuardedPipelineOptions {
  shape: ErrorShape
}

// Auth, user-database binding, rate limiting and the body cap, in that order for both HTTP surfaces.
// The rate-limit store is deliberately per surface (one factory call each), as before: `/api` and
// `/mcp` keep separate counters. `shape` only picks the error body; see `createErrorHandler`.
export function createGuardedPipeline(options: GuardedPipelineOptions): MiddlewareHandler[] {
  const bodyCap: MiddlewareHandler = async (c, next) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > MAX_REQUEST_BODY_BYTES) return bodyTooLargeResponse(options.shape)
    return next()
  }

  return [authMiddleware, bindUserContext, createRateLimitMiddleware(), bodyCap]
}
