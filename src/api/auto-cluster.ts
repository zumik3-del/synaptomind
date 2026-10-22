import { Hono } from 'hono'
import { z } from 'zod/v4'
import { type AutoClusterOptions, getLastAutoClusterStatus, runAutoClusterJob } from '../services/auto-cluster.service'
import { jsonBodyOrDefault } from './utils'

const autoClusterRouter = new Hono()

interface TriggerBody {
  min_age_days?: number
  min_similarity?: number
  min_members?: number
  dry_run?: boolean
}

const triggerBodySchema = z.object({
  min_age_days: z.number().int().min(0).max(3650).optional(),
  min_similarity: z.number().finite().min(0).max(1).optional(),
  min_members: z.number().int().min(1).max(1000).optional(),
  dry_run: z.boolean().optional(),
})

autoClusterRouter.post('/auto-cluster/trigger', async c => {
  const body = await jsonBodyOrDefault<TriggerBody>(c, {}, triggerBodySchema)

  const options: AutoClusterOptions = {}
  if (body.min_age_days !== undefined) options.minAgeDays = body.min_age_days
  if (body.min_similarity !== undefined) options.minSimilarity = body.min_similarity
  if (body.min_members !== undefined) options.minMembers = body.min_members
  if (body.dry_run !== undefined) options.dryRun = body.dry_run

  try {
    const result = await runAutoClusterJob(options)
    return c.json(result)
  } catch (err) {
    console.error('[synaptomind] auto-cluster job failed:', err)
    return c.json({ error: 'Auto-cluster job failed' }, 500)
  }
})

autoClusterRouter.get('/auto-cluster/status', c => {
  return c.json(getLastAutoClusterStatus())
})

export { autoClusterRouter }
