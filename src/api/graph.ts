import { Hono } from 'hono'
import { z } from 'zod/v4'
import { withTelemetry } from '../logging'
import { ValidationError } from '../errors'
import { GRAPH_LIMIT_DEFAULT, graphLimitSchema, graphStatusSchema } from '../validation'
import { getGraphDataService } from '../services/graph.service'
import { formatZodIssues } from './utils'

const graphRouter = new Hono()

// Shared request contract (audit M8): status and limit are validated with the
// same schemas the `memory_crystallize action=graph` tool advertises, so an
// out-of-range value is a typed 400 instead of a silent clamp.
const graphQuerySchema = z.object({
  status: graphStatusSchema.default('active'),
  limit: graphLimitSchema.default(GRAPH_LIMIT_DEFAULT)
})

graphRouter.get('/graph', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought_graph' }, c2 => {
    const parsed = graphQuerySchema.safeParse({
      status: c2.req.query('status') || undefined,
      limit: c2.req.query('limit') || undefined
    })
    if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
    return c2.json(getGraphDataService(c2.req.query('project_id'), parsed.data.status, parsed.data.limit))
  })
})

export { graphRouter }
