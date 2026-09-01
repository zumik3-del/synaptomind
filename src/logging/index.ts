import { insertTelemetry as _insertTelemetry } from './log'

export { closeLogDb, getLogDb, insertLog, insertTelemetry, type TelemetryInsertOpts } from './log'

/** HTTP-side telemetry guard.
 *
 * Returns the correlation context for an insertTelemetry call, or null when
 * the request came from the MCP server: the MCP middleware already wrote the
 * outer thought_telemetry row (with prev_tool/session truth), so writing
 * another row here would double-count every tool invocation.
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

export function withTelemetry(c: any, fields: TelemetryFields, fn: (c: any) => any): any {
  const t0 = performance.now()
  const run = (result: any): any => {
    const latencyMs = Math.round(performance.now() - t0)
    const ctx = telemetryContext(c)
    if (ctx) {
      void _insertTelemetry({ ...fields, latencyMs, responseSize: 0, ...ctx })
    }
    return result
  }
  try {
    const result = fn(c)
    if (result instanceof Promise) {
      return result.then(run)
    }
    return run(result)
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0)
    const ctx = telemetryContext(c)
    if (ctx) {
      void _insertTelemetry({ ...fields, latencyMs, responseSize: 0, ...ctx })
    }
    throw err
  }
}
