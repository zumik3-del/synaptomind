import { Hono } from 'hono'
import { summarizeProfile } from '../services/profile.service'
import { getProfileThoughtsService, getProfileStatsService } from '../services/profile.service'

const profileRouter = new Hono()

profileRouter.get('/thoughts', c => {
  const thoughts = getProfileThoughtsService()
  return c.json(thoughts)
})

profileRouter.get('/stats', c => {
  const stats = getProfileStatsService()
  return c.json(stats)
})

profileRouter.post('/summarize', c => {
  const result = summarizeProfile()
  return c.json(result)
})

export { profileRouter }
