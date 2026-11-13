import type { Context, Next } from 'hono'
import { resolveUser } from '../auth'
import { als, getDb, getUserDb } from '../context/container'

export async function bindUserContext(c: Context, next: Next) {
  const ref = resolveUser(c.req.header('Authorization'))
  if (!ref) return c.json({ error: 'Unauthorized' }, 401)

  const db = ref.kind === 'legacy' ? getDb() : getUserDb(ref.userId)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  return als.run({ userId: ref.userId, db }, next)
}
