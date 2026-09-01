import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { summarizeProfile } from '../services/profile.service'
import { getProfileThoughtsService, getProfileStatsService } from '../services/profile.service'

const profileRouter = new Hono()

profileRouter.get('/thoughts', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_profile', query: 'thoughts' }, c2 => {
    const thoughts = getProfileThoughtsService()
    return c2.json(thoughts)
  })
})

profileRouter.get('/stats', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_profile', query: 'stats' }, c2 => {
    const stats = getProfileStatsService()
    return c2.json(stats)
  })
})

profileRouter.post('/summarize', c => {
  return withTelemetry(c, { action: 'write', toolName: 'summarize_profile' }, c2 => {
    const result = summarizeProfile()
    return c2.json(result)
  })
})

export { profileRouter }
