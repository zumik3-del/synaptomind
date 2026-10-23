import { Hono } from 'hono'
import { z } from 'zod/v4'
import { ValidationError } from '../errors'
import { listRetentionReviewCandidatesService } from '../services/retention-review.service'
import {
  compactRetentionReviewCandidatesService,
  deleteRetentionReviewCandidateService,
  protectRetentionReviewCandidateService
} from '../services/retention-review-actions.service'
import { formatZodIssues, requiredJsonBody } from './utils'

const retentionReviewRouter = new Hono()

const querySchema = z.object({
  minAgeDays: z.coerce.number().finite().min(0).optional(),
  importanceFloor: z.coerce.number().finite().min(0).max(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional()
})
const confirmBodySchema = z.object({ confirm: z.boolean().optional() })
const compactBodySchema = z.object({
  source_ids: z.array(z.string().min(1)).min(1),
  summary: z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional(),
    project_id: z.string().min(1).optional()
  }),
  confirm: z.boolean().optional()
})

retentionReviewRouter.get('/retention-review', c => {
  const parsed = querySchema.safeParse({
    minAgeDays: c.req.query('minAgeDays'),
    importanceFloor: c.req.query('importanceFloor'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset')
  })
  if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
  return c.json(listRetentionReviewCandidatesService(parsed.data))
})

retentionReviewRouter.post('/retention-review/compact', async c => {
  const body = await requiredJsonBody(c, compactBodySchema)
  return c.json(compactRetentionReviewCandidatesService(body))
})

retentionReviewRouter.post('/:id/retention-review/protect', c => {
  return c.json(protectRetentionReviewCandidateService(c.req.param('id')!))
})

retentionReviewRouter.post('/:id/retention-review/delete', async c => {
  const body = await requiredJsonBody(c, confirmBodySchema)
  return c.json(deleteRetentionReviewCandidateService(c.req.param('id')!, body))
})

export { retentionReviewRouter }
