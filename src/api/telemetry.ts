import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { getLogDb } from '../logging'
import { windowStart } from '../services/utils'
import {
  queryPatterns,
  queryFrequency,
  queryOrphanWritesDetail,
  queryDraftLifecycleDetailed
} from '../services/telemetry-queries'

type Env = { Variables: { logDb: Database } }

const telemetryRouter = new Hono<Env>()

telemetryRouter.use('*', async (c, next) => {
  const db = getLogDb()
  if (!db) return c.json({ error: 'LOG_DB_PATH not set' }, 503)
  c.set('logDb', db)
  return next()
})

telemetryRouter.get('/patterns', c => {
  const db = c.get('logDb')
  const windowSecs = Math.max(60, parseInt(c.req.query('window') || '86400', 10))
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '10', 10)))
  const since = windowStart(windowSecs)

  const rows = queryPatterns(db, since, limit)
  const patterns = rows.map(r => ({
    sequence: r.prev_tool ? `${r.prev_tool} → ${r.tool_name}` : r.tool_name,
    prev_tool: r.prev_tool,
    tool_name: r.tool_name,
    count: r.count
  }))
  return c.json({ window_secs: windowSecs, limit, patterns })
})

telemetryRouter.get('/frequency', c => {
  const db = c.get('logDb')
  const windowSecs = Math.max(3600, parseInt(c.req.query('window') || '86400', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10)))
  const since = windowStart(windowSecs)

  const rows = queryFrequency(db, since, limit)
  const byAction = Object.fromEntries(rows.map(r => [r.action, r.count]))
  const total = rows.reduce((s, r) => s + r.count, 0)
  const hours = Math.max(1, windowSecs / 3600)
  return c.json({
    window_secs: windowSecs,
    total_calls: total,
    per_hour: Math.round((total / hours) * 10) / 10,
    by_action: byAction
  })
})

telemetryRouter.get('/orphan_writes', c => {
  const db = c.get('logDb')
  const windowSecs = Math.max(3600, parseInt(c.req.query('window') || '86400', 10))
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100', 10)))
  const since = windowStart(windowSecs)

  const rows = queryOrphanWritesDetail(db, since, limit)
  return c.json({
    window_secs: windowSecs,
    count: rows.length,
    writes: rows.map(r => ({
      id: r.id, tool_name: r.tool_name, prev_tool: r.prev_tool, thought_id: r.thought_id, created_at: r.created_at
    }))
  })
})

telemetryRouter.get('/draft_lifecycle', c => {
  const db = c.get('logDb')
  const windowSecs = Math.max(86400, parseInt(c.req.query('window') || '2592000', 10))
  const since = windowStart(windowSecs)

  const lifecycle = queryDraftLifecycleDetailed(db, since)
  return c.json({ window_secs: windowSecs, ...lifecycle })
})

export { telemetryRouter }
