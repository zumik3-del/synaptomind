import type { Context } from 'hono'
import { insertTelemetry as _insertTelemetry } from './log'

export { closeLogDb, getLogDb, insertLog, insertTelemetry, type TelemetryInsertOpts } from './log'

/** HTTP-side telemetry guard.
 *
 * Returns the correlation context for an insertTelemetry call, or null when the
 * caller opts out by sending `X-Client: mcp`. MCP tool calls are instrumented
 * directly at dispatch (src/mcp/telemetry.ts) and never traverse these HTTP
 * routes, so this header is an explicit opt-out for callers that already
 * recorded the invocation upstream — writing another row here would
 * double-count it.
 */
export function telemetryContext(c: { req: { header(name: string): string | undefined } }): {
  correlationId?: string
} | null {
  if (c.req.header('X-Client') === 'mcp') return null
  return { correlationId: c.req.header('X-Correlation-Id') || undefined }
}

type TelemetryFields = {
  action: 'read' | 'write' | 'link' | 'explore'
  toolName: string
  thoughtId?: string
  query?: string
  meta?: Record<string, unknown>
}

export function withTelemetry<T>(c: Context, fields: TelemetryFields, fn: (c: Context) => T): T {
  const t0 = performance.now()
  const recordTelemetry = (): void => {
    const latencyMs = Math.round(performance.now() - t0)
    const ctx = telemetryContext(c)
    if (ctx) {
      void _insertTelemetry({ ...fields, latencyMs, responseSize: 0, ...ctx })
    }
  }
  try {
    const result = fn(c)
    if (result instanceof Promise) {
      return result.then(
        (v) => { recordTelemetry(); return v },
        (err) => { recordTelemetry(); throw err }
      ) as T
    }
    recordTelemetry()
    return result
  } catch (err) {
    recordTelemetry()
    throw err
  }
}
