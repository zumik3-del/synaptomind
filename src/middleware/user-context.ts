import type { Database } from 'bun:sqlite'
import type { Context, Next } from 'hono'
import { resolveUser, type UserRef } from '../auth'
import { als, getDb, getUserDb } from '../context/container'

declare module 'hono' {
  interface ContextVariableMap {
    // Set by this middleware; the MCP route reads the resolved ref back to bind a session's owner.
    mcpUser?: UserRef
  }
}

// A throw means the database is not there yet (uninitialized or still registering), not a hard
// failure: the caller decides between a 503 and letting the handler report it.
function resolveDatabase(ref: UserRef): Database | undefined {
  try {
    return ref.kind === 'legacy' ? getDb() : getUserDb(ref.userId)
  } catch {
    return undefined
  }
}

export async function bindUserContext(c: Context, next: Next) {
  const ref = resolveUser(c.req.header('Authorization'))
  if (!ref) return c.json({ error: 'Unauthorized' }, 401)

  const db = resolveDatabase(ref)
  // A legacy token has no per-user database: an uninitialized default one is the handlers'
  // concern (they throw, the error handler answers), while a configured user without a database
  // is this middleware's 503.
  if (!db && ref.kind !== 'legacy') return c.json({ error: 'Database unavailable' }, 503)

  c.set('mcpUser', ref)
  return als.run({ userId: ref.userId, db: db as Database }, next)
}
