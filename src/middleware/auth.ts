import type { Context, Next } from 'hono'
import { checkBearerAuth } from '../auth'

// Shared by the HTTP API (/api/*) and the MCP HTTP transport (/mcp) so the
// bearer-token contract stays identical across both protocols (F19).
export async function authMiddleware(c: Context, next: Next) {
  const auth = c.req.header('Authorization')
  if (checkBearerAuth(auth)) return next()
  return c.json({ error: 'Unauthorized' }, 401)
}
