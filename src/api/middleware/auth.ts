import type { Context, Next } from 'hono'
import { checkBearerAuth } from '../../auth'

export async function authMiddleware(c: Context, next: Next) {
  const auth = c.req.header('Authorization')
  if (checkBearerAuth(auth)) return next()
  return c.json({ error: 'Unauthorized' }, 401)
}
