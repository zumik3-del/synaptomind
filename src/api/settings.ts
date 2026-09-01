import { Hono } from 'hono'
import {
  getEmbedderIdleTimeoutMs,
  getEmbedderPrecache,
  getThoughtLimits,
  setEmbedderIdleTimeoutMs,
  setEmbedderPrecache,
  setThoughtLimits
} from '../db/settings'
import { restartEmbedder } from '../embedder/client'

const settingsRouter = new Hono()

settingsRouter.get('/thought-settings', c => {
  return c.json(getThoughtLimits())
})

settingsRouter.patch('/thought-settings', async c => {
  const body = await c.req.json<{ softLimit?: number; hardLimit?: number }>()
  const softLimit = body.softLimit
  const hardLimit = body.hardLimit

  if (softLimit === undefined || hardLimit === undefined) {
    return c.json({ error: 'softLimit and hardLimit are required' }, 400)
  }
  if (!Number.isInteger(softLimit) || softLimit < 1) {
    return c.json({ error: 'softLimit must be an integer >= 1' }, 400)
  }
  if (!Number.isInteger(hardLimit) || hardLimit <= softLimit) {
    return c.json({ error: 'hardLimit must be an integer greater than softLimit' }, 400)
  }

  setThoughtLimits(softLimit, hardLimit)
  return c.json(getThoughtLimits())
})

settingsRouter.get('/embedder-settings', c => {
  return c.json({ precache: getEmbedderPrecache(), idleTimeoutMs: getEmbedderIdleTimeoutMs() })
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

  const previousPrecache = getEmbedderPrecache()
  const previousIdle = getEmbedderIdleTimeoutMs()
  if (precache !== undefined) setEmbedderPrecache(precache)
  if (idleTimeoutMs !== undefined) setEmbedderIdleTimeoutMs(idleTimeoutMs)

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
  return c.json({ precache: getEmbedderPrecache(), idleTimeoutMs: getEmbedderIdleTimeoutMs() })
})

export { settingsRouter }
