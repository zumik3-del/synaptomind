import type { Context, Next } from 'hono'
import { checkBearerAuth } from '../auth'
import { config, type Config } from '../config'

export async function authMiddleware(c: Context, next: Next, cfg: Config = config) {
  const auth = c.req.header('Authorization')
  if (checkBearerAuth(auth, cfg)) return next()
  return c.json({ error: 'Unauthorized' }, 401)
}
