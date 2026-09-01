import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { type EntityType, listEntities } from '../services/entity.service'
import { searchThoughts, searchThoughtsGrouped } from '../services/search.service'
import { postProcessSearchResults } from '../services/search_postprocess.service'

export const searchRouter = new Hono()

interface HintItem {
  id: string
  content_short: string
  similarity: number
  project_name: string | undefined
  tags: Array<{ id: string; name: string }>
  compact: true
}

searchRouter.get('/search', async c => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'query "q" is required' }, 400)
  const k = parseInt(c.req.query('k') || '10', 10)
  const status = c.req.query('status') || 'active'
  const project_id = c.req.query('project_id')
  const tag = c.req.query('tag')
  const clusterOpt = c.req.query('cluster')
  const excludeClusters = c.req.query('exclude_clusters') === 'true'
  const groupByCluster = c.req.query('group_by_cluster') === 'true'
  const minImportance = c.req.query('min_importance') ? parseFloat(c.req.query('min_importance')!) : undefined
  const showPrimers = c.req.query('show_primers') !== 'false'
  const excludeFlagged = c.req.query('exclude_flagged') === 'true'
  const hybridParam = c.req.query('hybrid')
  const hybrid = hybridParam === null ? true : hybridParam !== '0'

  let clusterFilter: 'only' | 'exclude' | undefined
  if (clusterOpt === 'true') clusterFilter = 'only'
  if (excludeClusters) clusterFilter = 'exclude'

  return withTelemetry(c, { action: 'read', toolName: 'search_thoughts', query: q }, async c2 => {
    const searchOpts = {
      query: q, topK: k, statusFilter: status, projectFilter: project_id,
      tagFilter: tag, clusterFilter, minImportance, excludeFlagged, hybrid
    }
    let results = groupByCluster
      ? await searchThoughtsGrouped(searchOpts)
      : await searchThoughts(searchOpts)
    results = postProcessSearchResults(results, { query: q, topK: k, showPrimers })
    return c2.json(results)
  })
})

searchRouter.get('/search/hints', async c => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'query "q" is required' }, 400)
  const k = Math.max(1, Math.min(10, parseInt(c.req.query('k') || '3', 10)))
  const maxLength = Math.max(20, parseInt(c.req.query('max_length') || '80', 10))
  try {
    const results = await searchThoughts({ query: q, topK: k, statusFilter: 'active' })
    const hints: HintItem[] = results.map(r => ({
      id: r.thought.id,
      content_short: r.thought.content.slice(0, maxLength),
      similarity: r.similarity,
      project_name: r.thought.project_name,
      tags: r.thought.tags.map(tag => ({ id: tag.id, name: tag.name })),
      compact: true as const
    }))
    return c.json(hints)
  } catch (err: unknown) {
    console.error('[thoughts] hints failed:', err)
    throw err
  }
})

searchRouter.get('/entities', c => {
  const typeParam = c.req.query('type')
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100', 10)))
  const type = typeParam && ['code', 'tag', 'wiki', 'term'].includes(typeParam) ? (typeParam as EntityType) : undefined
  return c.json(listEntities({ type, limit }))
})
