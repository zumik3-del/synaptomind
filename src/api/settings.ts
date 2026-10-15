import { Hono } from 'hono'
import { restartEmbedder } from '../embedder/client'
import {
  getEmbedderIdleTimeoutMsService,
  getEmbedderPrecacheService,
  getThoughtLimitsService,
  setEmbedderIdleTimeoutMsService,
  setEmbedderPrecacheService,
  setThoughtLimitsService
} from '../services/settings.service'

// Intentionally NOT wrapped in withTelemetry: runtime configuration endpoints
// (thought limits, embedder tuning) are infrastructure, not memory operations.
const settingsRouter = new Hono()

settingsRouter.get('/thought-settings', c => {
  return c.json(getThoughtLimitsService())
})

settingsRouter.patch('/thought-settings', async c => {
  const body = await c.req.json<{ softLimit?: number; hardLimitBufferPercent?: number }>()
  const { softLimit, hardLimitBufferPercent } = body

  if (softLimit === undefined && hardLimitBufferPercent === undefined) {
    return c.json({ error: 'at least one of softLimit or hardLimitBufferPercent is required' }, 400)
  }
  if (softLimit !== undefined && (!Number.isInteger(softLimit) || softLimit < 1)) {
    return c.json({ error: 'softLimit must be an integer >= 1' }, 400)
  }
  if (hardLimitBufferPercent !== undefined && (!Number.isInteger(hardLimitBufferPercent) || hardLimitBufferPercent < 1)) {
    return c.json({ error: 'hardLimitBufferPercent must be an integer >= 1' }, 400)
  }

  const current = getThoughtLimitsService()
  return c.json(
    setThoughtLimitsService(
      softLimit ?? current.softLimit,
      hardLimitBufferPercent ?? current.hardLimitBufferPercent
    )
  )
})

settingsRouter.get('/embedder-settings', c => {
  return c.json({ precache: getEmbedderPrecacheService(), idleTimeoutMs: getEmbedderIdleTimeoutMsService() })
})

settingsRouter.patch('/embedder-settings', async c => {
  const body = await c.req.json<{ precache?: boolean; idleTimeoutMs?: number }>()
  const { precache, idleTimeoutMs } = body

  if (precache !== undefined && typeof precache !== 'boolean') {
    return c.json({ error: 'precache must be a boolean' }, 400)
  }
  if (idleTimeoutMs !== undefined) {
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1000) {
      return c.json({ error: 'idleTimeoutMs must be an integer >= 1000' }, 400)
    }
  }
  if (precache === undefined && idleTimeoutMs === undefined) {
    return c.json({ error: 'at least one of precache or idleTimeoutMs is required' }, 400)
  }

  const previousPrecache = getEmbedderPrecacheService()
  const previousIdle = getEmbedderIdleTimeoutMsService()
  if (precache !== undefined) setEmbedderPrecacheService(precache)
  if (idleTimeoutMs !== undefined) setEmbedderIdleTimeoutMsService(idleTimeoutMs)

  const changed =
    (precache !== undefined && precache !== previousPrecache) ||
    (idleTimeoutMs !== undefined && idleTimeoutMs !== previousIdle)

  if (changed) {
    try {
      await restartEmbedder()
    } catch (err) {
      return c.json(
        { error: `setting saved but restart failed: ${err instanceof Error ? err.message : String(err)}` },
        500
      )
    }
  }
  return c.json({ precache: getEmbedderPrecacheService(), idleTimeoutMs: getEmbedderIdleTimeoutMsService() })
})

export { settingsRouter }
