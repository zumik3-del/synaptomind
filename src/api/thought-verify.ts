import { Hono } from 'hono'
import { runVerifyJob } from '../services/thought_verify.service'

const thoughtVerifyRouter = new Hono()

thoughtVerifyRouter.post('/run', async c => {
  try {
    const stats = await runVerifyJob()
    return c.json({ ok: true, ...stats })
  } catch (err) {
    console.error('[thought-verify] job error:', err)
    return c.json({ error: 'Verify job failed', ok: false }, 500)
  }
})

export { thoughtVerifyRouter }
