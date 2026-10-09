import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { searchThoughts, searchThoughtsGrouped } from '../services/search.service'
import { postProcessSearchResults } from '../services/search_postprocess.service'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseOptionalNumber,
  parseSupersessionMode
} from '../services/search-options'

const searchRouter = new Hono()

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

  const searchOpts = buildSearchOptions({
    query: q, topK: k, status, projectFilter: project_id,
    tagFilter: tag, clusterFilter, minImportance, excludeFlagged, hybrid,
    includeGlobal: c.req.query('include_global') === 'true',
    supersessionMode: parseSupersessionMode(c.req.query('supersession_mode')),
    contradictionMode: parseContradictionMode(c.req.query('contradiction_mode')),
    recencyWeight: parseOptionalNumber(c.req.query('recency_weight'), 'recency_weight'),
    recencyHalfLifeDays: parseOptionalNumber(c.req.query('recency_half_life_days'), 'recency_half_life_days'),
    minRelevance: parseOptionalNumber(c.req.query('min_relevance'), 'min_relevance')
  })

  return withTelemetry(c, { action: 'read', toolName: 'search_thoughts', query: q }, async c2 => {
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
  return withTelemetry(c, { action: 'read', toolName: 'search_hints', query: q }, async c2 => {
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
      return c2.json(hints)
    } catch (err: unknown) {
      console.error('[thoughts] hints failed:', err)
      throw err
    }
  })
})

export { searchRouter }
