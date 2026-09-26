import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { runVerifyJob } from '../services/thought_verify.service'

const thoughtVerifyRouter = new Hono()

thoughtVerifyRouter.post('/run', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'run_thought_verify' }, async c2 => {
    try {
      const stats = await runVerifyJob()
      return c2.json({ ok: true, ...stats })
    } catch (err) {
      console.error('[thought-verify] job error:', err)
      return c2.json({ error: 'Verify job failed', ok: false }, 500)
    }
  })
})

export { thoughtVerifyRouter }
