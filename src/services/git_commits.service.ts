import { config } from '../config'
import { countGitCommits as dbCountGitCommits, listGitCommits as dbListGitCommits, queueGitEmbedding, upsertGitCommit } from '../db/git_commits'
import { getDb } from '../db'
import { getProject } from '../db/projects'
import { normalizeRepoKey } from '../db/repo_key'
import { isRemoteUrl } from './utils'
import { ValidationError } from './errors'
import { realpathSync, statSync } from 'fs'
import { resolve } from 'path'

export function listGitCommitsService(limit = 50, offset = 0, projectId?: string) {
  return dbListGitCommits(getDb(), limit, offset, projectId)
}

export function countGitCommitsService(projectId?: string) {
  return dbCountGitCommits(getDb(), projectId)
}

export interface IndexCommitsInput {
  repo_path?: string
  repo?: string
  project_id?: string | null
  limit?: number
  since_hash?: string
}

export interface IndexCommitsResult {
  repo_path: string
  repo: string
  project_id?: string | null
  scanned: number
  indexed: number
  skipped: number
  queued_embeddings: number
}

interface RawCommit {
  hash: string
  author: string | null
  committed_at: string
  message: string
}

// %x01 separates fields, %x00 separates records — both survive multi-line
// commit bodies (%B) and unusual authors that would break whitespace parsing.
// A3: store the FULL body (%B), not just the subject (%s), so local commits
// match remote commits (which already store the full message) and search
// embeddings see the same content.
const LOG_FORMAT = '%H%x01%an%x01%ad%x01%B%x00'

function validateRepoPath(repoPath: string): void {
  const allowed = config.git.allowedRepos
  if (allowed.length === 0) return

  let real: string
  try {
    const stat = statSync(repoPath)
    if (!stat.isDirectory()) {
      throw new ValidationError(`repo_path is not a directory: ${repoPath}`)
    }
    real = realpathSync(repoPath)
  } catch (err) {
    if (err instanceof ValidationError) throw err
    throw new ValidationError(`repo_path does not exist or is inaccessible: ${repoPath}`)
  }

  const isAllowed = allowed.some(dir => {
    const resolved = resolve(dir)
    return real === resolved || real.startsWith(resolved + '/')
  })
  if (!isAllowed) {
    throw new ValidationError(`repo_path is not in allowed directories: ${repoPath}`)
  }
}

function parseLog(text: string): RawCommit[] {
  const commits: RawCommit[] = []
  for (const record of text.split('\x00')) {
    if (!record.trim()) continue
    const parts = record.split('\x01')
    const hash = parts[0]
    const author = parts[1] || null
    const date = parts[2]
    // message may itself contain '%x01' rarely; re-join to be safe.
    const message = parts.slice(3).join('\x01')
    if (!hash || !date || !message) continue
    commits.push({ hash, author, committed_at: date, message })
  }
  return commits
}

export async function indexGitCommits(input: IndexCommitsInput = {}): Promise<IndexCommitsResult> {
  const repoPath = input.repo_path
  if (!repoPath) throw new ValidationError('repo_path is required')
  validateRepoPath(repoPath)
  const repo = normalizeRepoKey(input.repo || repoPath)
  const limit = input.limit ?? config.git.defaultLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new ValidationError('limit must be an integer between 1 and 10000')
  }

  const args = ['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`, '--date=iso']
  if (input.since_hash) args.push(`${input.since_hash}..HEAD`)
  let stdout: string
  let stderr: string
  let exitCode: number
  try {
    const proc = Bun.spawn(['git', '-C', repoPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    stdout = await new Response(proc.stdout).text()
    stderr = await new Response(proc.stderr).text()
    exitCode = await proc.exited
  } catch (err) {
    // Missing git binary (spawn ENOENT) surfaces as the same friendly 400.
    const msg = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`git log failed in ${repoPath}: ${msg.slice(0, 300)}`)
  }
  if (exitCode !== 0) {
    const hint = input.since_hash ? ' (since_hash must be an ancestor of HEAD)' : ''
    throw new ValidationError(`git log failed in ${repoPath}: ${stderr.trim().slice(0, 300)}${hint}`)
  }

  const d = getDb()
  const commits = parseLog(stdout)
  let indexed = 0
  let queued = 0
  for (const c of commits) {
    const { commit, created } = upsertGitCommit(d, {
      hash: c.hash,
      message: c.message,
      committed_at: c.committed_at,
      author: c.author,
      repo,
      project_id: input.project_id
    })
    if (created) {
      indexed++
      queueGitEmbedding(d, commit.id)
      queued++
    }
  }
  return {
    repo_path: repoPath,
    repo,
    project_id: input.project_id,
    scanned: commits.length,
    indexed,
    skipped: commits.length - indexed,
    queued_embeddings: queued
  }
}

// ── Remote (public repo) indexing via platform API ───────────────────────────
// issue #226: a public Forgejo/GitHub repository is indexed through its commits
// API — no local clone, no credentials (anonymous GET; repo must be public).
export { isRemoteUrl }

export function parseRemoteRepo(url: string): { host: string; owner: string; repo: string } | null {
  // normalizeRepoKey already rewrites ssh/git@ and forces https, so we only
  // need to split host from the rest and divide the rest on the LAST slash —
  // owner may itself contain '/' for nested Forgejo/GitHub groups.
  const key = normalizeRepoKey(url)
  const m = key.match(/^https:\/\/([^/]+)\/(.+)$/)
  if (!m) return null
  const host = m[1]
  const rest = m[2].replace(/\/+$/, '')
  const idx = rest.lastIndexOf('/')
  if (idx <= 0) return null
  const owner = rest.slice(0, idx)
  const repo = rest.slice(idx + 1)
  if (!owner || !repo) return null
  return { host, owner, repo }
}

function validateHost(host: string): void {
  const allowed = config.git.allowedHosts
  if (allowed.length === 0) return

  const isAllowed = allowed.some(pattern => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      return host === pattern.slice(2) || host.endsWith(suffix)
    }
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      return regex.test(host)
    }
    return host === pattern
  })
  if (!isAllowed) {
    throw new ValidationError(`host not in git.allowedHosts: ${host}`)
  }
}

async function fetchJson(url: string): Promise<unknown> {
  // A9: bound the network call so a slow/hanging remote host doesn't stall the sync.
  const res = await fetch(url, {
    headers: { 'User-Agent': 'synaptomind/1.0' },
    signal: AbortSignal.timeout(15000)
  })
  return res
}

export async function indexGitCommitsFromRemote(
  url: string,
  projectId: string | null,
  limit = 500
): Promise<IndexCommitsResult> {
  const parsed = parseRemoteRepo(url)
  if (!parsed) throw new ValidationError(`cannot parse repo url: ${url}`)
  validateHost(parsed.host)
  const base = `https://${parsed.host}/api/v1/repos/${parsed.owner}/${parsed.repo}/commits`
  // A7: page through the commits API instead of relying on a single large
  // `limit` that the server may clamp — otherwise big repos silently lose history.
  const perPage = 100
  const collected: Array<{
    sha: string
    commit?: { message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } }
  }> = []
  let page = 1
  while (collected.length < limit) {
    const res = (await fetchJson(`${base}?limit=${perPage}&page=${page}`)) as Response
    if (!res.ok) {
      throw new ValidationError(`commits API ${res.status} for ${parsed.owner}/${parsed.repo} (repo must be public)`)
    }
    const batch = (await res.json()) as Array<{
      sha: string
      commit?: { message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } }
    }>
    if (!Array.isArray(batch) || batch.length === 0) break
    collected.push(...batch)
    if (batch.length < perPage) break
    page++
  }
  const data = collected.slice(0, limit)
  const repo = normalizeRepoKey(url)
  const d = getDb()
  let indexed = 0
  let queued = 0
  // A10: one transaction for the whole batch instead of N sequential writes.
  const tx = d.transaction((items: typeof data) => {
    for (const c of items) {
      const { commit, created } = upsertGitCommit(d, {
        hash: c.sha,
        message: c.commit?.message ?? '',
        committed_at: c.commit?.author?.date ?? c.commit?.committer?.date ?? new Date().toISOString(),
        author: c.commit?.author?.name ?? null,
        repo,
        project_id: projectId
      })
      if (created) {
        indexed++
        queueGitEmbedding(d, commit.id)
        queued++
      }
    }
  })
  tx(data)
  return {
    repo_path: url,
    repo,
    project_id: projectId,
    scanned: data.length,
    indexed,
    skipped: data.length - indexed,
    queued_embeddings: queued
  }
}

// issue #228: lightweight reachability/validity check for a git repo URL.
// Parses the URL the same way as the indexer (https, public Forgejo repo) and
// pings the repo metadata endpoint. Throws ValidationError on bad URL / private / missing.
export async function checkGitRepo(url: string): Promise<{
  ok: boolean
  host: string
  owner: string
  repo: string
  message: string
}> {
  const parsed = parseRemoteRepo(url)
  if (!parsed) throw new ValidationError(`cannot parse repo url: ${url}`)
  validateHost(parsed.host)
  const api = `https://${parsed.host}/api/v1/repos/${parsed.owner}/${parsed.repo}`
  const res = (await fetchJson(api)) as Response
  if (res.status === 404) {
    throw new ValidationError(`repo not found or private: ${parsed.owner}/${parsed.repo}`)
  }
  if (!res.ok) {
    throw new ValidationError(`repo API ${res.status} for ${parsed.owner}/${parsed.repo}`)
  }
  return {
    ok: true,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
    message: 'Repository is reachable and public'
  }
}

export async function indexProjectCommits(
  projectId: string,
  options?: { limit?: number; since_hash?: string }
): Promise<IndexCommitsResult> {
  const d = getDb()
  const project = getProject(d, projectId)
  if (!project) throw new ValidationError(`project not found: ${projectId}`)
  if (!project.git_repo_url) throw new ValidationError(`project "${project.name}" has no git_repo_url set`)

  const repoUrl = project.git_repo_url
  if (isRemoteUrl(repoUrl)) {
    return indexGitCommitsFromRemote(repoUrl, projectId, options?.limit)
  }
  return indexGitCommits({ repo_path: repoUrl, project_id: projectId, limit: options?.limit, since_hash: options?.since_hash })
}
