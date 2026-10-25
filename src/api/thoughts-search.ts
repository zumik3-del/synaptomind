import { Hono } from 'hono'
import { searchThoughts, searchThoughtsGrouped } from '../services/search.service'
import { postProcessSearchResults } from '../services/search_postprocess.service'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseOptionalNumber,
  parseSupersessionMode
} from '../services/search-options'

const searchRouter = new Hono()

searchRouter.get('/search', async c => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'query "q" is required' }, 400)
  const rawK = c.req.query('k')
  const k = rawK ? parseInt(rawK, 10) : 10
  if (!Number.isFinite(k) || k <= 0) return c.json({ error: 'invalid k' }, 400)
  const status = c.req.query('status') || 'active'
  const project_id = c.req.query('project_id')
  const tag = c.req.query('tag')
  const clusterOpt = c.req.query('cluster')
  const excludeClusters = c.req.query('exclude_clusters') === 'true'
  const groupByCluster = c.req.query('group_by_cluster') === 'true'
  const minImportance = c.req.query('min_importance') ? parseFloat(c.req.query('min_importance')!) : undefined
  const showPrimers = c.req.query('show_primers') !== 'false'
  const hybridParam = c.req.query('hybrid')
  const hybrid = hybridParam === null ? true : hybridParam !== '0'
  let clusterFilter: 'only' | 'exclude' | undefined
  if (clusterOpt === 'true') clusterFilter = 'only'
  if (excludeClusters) clusterFilter = 'exclude'

  const searchOpts = buildSearchOptions({
    query: q, topK: k, status, projectFilter: project_id,
    tagFilter: tag, clusterFilter, minImportance, hybrid,
    supersessionMode: parseSupersessionMode(c.req.query('supersession_mode')),
    contradictionMode: parseContradictionMode(c.req.query('contradiction_mode')),
    recencyWeight: parseOptionalNumber(c.req.query('recency_weight'), 'recency_weight'),
    recencyHalfLifeDays: parseOptionalNumber(c.req.query('recency_half_life_days'), 'recency_half_life_days'),
    minRelevance: parseOptionalNumber(c.req.query('min_relevance'), 'min_relevance')
  })

  let results = groupByCluster
    ? await searchThoughtsGrouped(searchOpts)
    : await searchThoughts(searchOpts)
  results = postProcessSearchResults(results, { query: q, topK: k, showPrimers })
  return c.json(results)
})

export { searchRouter }
