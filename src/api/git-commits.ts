import { Hono } from 'hono'
import { getDb } from '../db'
import { getGitCommitByHash, searchGitCommits } from '../db/git_commits'
import { generateEmbedding } from '../embedder/client'
import { withTelemetry, telemetryContext, insertTelemetry } from '../logging'
import { ValidationError } from '../services/errors'
import { checkGitRepo, indexGitCommits, indexGitCommitsFromRemote, isRemoteUrl, listGitCommitsService, countGitCommitsService } from '../services/git_commits.service'
import { jsonBodyOrDefault } from './utils'

const gitCommitsRouter = new Hono()

gitCommitsRouter.get('/', c => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 500)
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0
  const projectId = c.req.query('project') || undefined
  return c.json({ commits: listGitCommitsService(limit, offset, projectId), total: countGitCommitsService(projectId) })
})

gitCommitsRouter.get('/search', async c => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'query "q" is required' }, 400)
  const k = Math.min(parseInt(c.req.query('k') || '10', 10) || 10, 50)
  const projectId = c.req.query('project') || undefined
  const db = getDb()
  const t0 = performance.now()
  const embedding = await generateEmbedding(q)
  const hits = searchGitCommits(db, embedding, k, projectId)
  const ctx = telemetryContext(c)
  if (ctx)
    void insertTelemetry({
      action: 'read',
      toolName: 'git_search_commits',
      latencyMs: performance.now() - t0,
      ...ctx
    })
  return c.json(hits)
})

gitCommitsRouter.post('/check', async c => {
  const body = await jsonBodyOrDefault<{ repo?: string }>(c, {} as { repo?: string })
  if (!body?.repo?.trim()) return c.json({ ok: false, error: 'repo url is required' }, 400)
  try {
    const result = await checkGitRepo(body.repo.trim())
    return c.json(result)
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ ok: false, error: err.message }, 400)
    const message = err instanceof Error ? err.message : 'repository check failed'
    return c.json({ ok: false, error: message }, 400)
  }
})

gitCommitsRouter.get('/:hash', c => {
  const projectId = c.req.query('project') || undefined
  const commit = getGitCommitByHash(getDb(), c.req.param('hash'), projectId)
  if (!commit) return c.json({ error: 'Not found' }, 404)
  return c.json(commit)
})

gitCommitsRouter.post('/index', async c => {
  const body = await jsonBodyOrDefault<{
    repo_path?: string; repo?: string; project_id?: string; limit?: number; since_hash?: string
  }>(c, {} as { repo_path?: string; repo?: string; project_id?: string; limit?: number; since_hash?: string })
  return withTelemetry(c, { action: 'write', toolName: 'git_index_commits' }, async c2 => {
    try {
      const result =
        body?.repo && isRemoteUrl(body.repo)
          ? await indexGitCommitsFromRemote(body.repo, body.project_id ?? null, body.limit ?? 500)
          : await indexGitCommits(body ?? {})
      return c2.json(result)
    } catch (err) {
      if (err instanceof ValidationError) return c2.json({ error: err.message }, 400)
      throw err
    }
  })
})

export { gitCommitsRouter }
