import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'
import { hasVec } from './init'
import { normalizeRepoKey } from './repo_key'

export interface GitCommit {
  id: string
  repo: string
  project_id: string | null
  hash: string
  message: string
  committed_at: string
  author: string | null
  created_at: string
}

export function getGitCommitByHash(db: Database, hash: string, projectId?: string): GitCommit | undefined {
  const row = projectId
    ? (db.prepare(`SELECT * FROM git_commits WHERE hash = ? AND project_id = ?`).get(hash, projectId) as
        | GitCommit
        | undefined
        | null)
    : (db.prepare(`SELECT * FROM git_commits WHERE hash = ?`).get(hash) as GitCommit | undefined | null)
  return row ?? undefined
}

export interface UpsertGitCommitInput {
  hash: string
  message: string
  committed_at: string
  author?: string | null
  repo?: string
  repo_path?: string
  project_id?: string | null
}

export function upsertGitCommit(db: Database, input: UpsertGitCommitInput): { commit: GitCommit; created: boolean } {
  const repo = normalizeRepoKey(input.repo || input.repo_path || '') || ''
  const existing = db.prepare(`SELECT * FROM git_commits WHERE repo = ? AND hash = ?`).get(repo, input.hash) as
    | GitCommit
    | undefined
    | null
  if (existing) {
    if (input.project_id !== undefined && input.project_id !== existing.project_id) {
      db.prepare(`UPDATE git_commits SET project_id = ? WHERE id = ?`).run(input.project_id ?? null, existing.id)
      existing.project_id = input.project_id ?? null
    }
    return { commit: existing, created: false }
  }
  const id = uuidv7()
  db.prepare(
    `INSERT INTO git_commits (id, repo, project_id, hash, message, committed_at, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    repo,
    input.project_id ?? null,
    input.hash,
    input.message,
    input.committed_at,
    input.author ?? null,
    new Date().toISOString()
  )
  const commit = db.prepare(`SELECT * FROM git_commits WHERE repo = ? AND hash = ?`).get(repo, input.hash) as
    | GitCommit
    | undefined
  if (!commit) throw new Error(`git commit insert failed: ${input.hash}`)
  return { commit, created: true }
}

export function listGitCommits(db: Database, limit = 50, offset = 0, projectId?: string): GitCommit[] {
  if (projectId) {
    return db
      .prepare(`SELECT * FROM git_commits WHERE project_id = ? ORDER BY committed_at DESC LIMIT ? OFFSET ?`)
      .all(projectId, limit, offset) as GitCommit[]
  }
  return db
    .prepare(`SELECT * FROM git_commits ORDER BY committed_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as GitCommit[]
}

export function countGitCommits(db: Database, projectId?: string): number {
  return projectId
    ? (db.prepare(`SELECT COUNT(*) as c FROM git_commits WHERE project_id = ?`).get(projectId) as { c: number }).c
    : (db.prepare(`SELECT COUNT(*) as c FROM git_commits`).get() as { c: number }).c
}

// ── Embedding queue ──────────────────────────────────────────────────────────

export function queueGitEmbedding(db: Database, commitId: string): void {
  db.prepare(`INSERT OR IGNORE INTO pending_git_embeddings (commit_id, created_at) VALUES (?, ?)`).run(
    commitId,
    new Date().toISOString()
  )
}

export function findPendingGitEmbeddings(db: Database, batchSize: number): { id: string; content: string }[] {
  return db
    .prepare(`
    SELECT p.commit_id AS id, gc.message AS content
    FROM pending_git_embeddings p
    JOIN git_commits gc ON gc.id = p.commit_id
    WHERE p.is_error = 0
    ORDER BY p.created_at
    LIMIT ?
  `)
    .all(batchSize) as { id: string; content: string }[]
}

export function deleteGitQueueItems(db: Database, ids: string[]): void {
  const del = db.prepare(`DELETE FROM pending_git_embeddings WHERE commit_id = ?`)
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id)
  })
  tx()
}

const GIT_MAX_ATTEMPTS = 10

export function handleFailedGitItem(db: Database, id: string, error: string): void {
  const row = db.prepare(`SELECT attempts FROM pending_git_embeddings WHERE commit_id = ?`).get(id) as
    | { attempts: number }
    | undefined
  const nextAttempt = (row?.attempts ?? 0) + 1
  if (nextAttempt >= GIT_MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE pending_git_embeddings SET attempts = ?, last_error = ?, is_error = 1, error = ? WHERE commit_id = ?`
    ).run(nextAttempt, error, error, id)
  } else {
    db.prepare(`UPDATE pending_git_embeddings SET attempts = ?, last_error = ? WHERE commit_id = ?`).run(
      nextAttempt,
      error,
      id
    )
  }
}

export function insertGitEmbedding(db: Database, id: string, embedding: Float32Array): void {
  db.prepare('DELETE FROM vec_git_commits WHERE id = ?').run(id)
  db.prepare(
    'INSERT INTO vec_git_commits (id, embedding) VALUES (?, ?)'
  ).run(
    id,
    Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
  )
}

// ── Semantic search ─────────────────────────────────────────────────────────

export interface GitCommitHit {
  id: string
  hash: string
  message: string
  committed_at: string
  author: string | null
  repo: string
  distance: number
  similarity: number
}

export function buildGitSearchParams(embeddingBuf: Buffer, topK: number, projectId?: string): SQLQueryBindings[] {
  const params: SQLQueryBindings[] = [embeddingBuf, Math.min(1000, Math.max(topK * 5, topK))]
  if (projectId) params.push(projectId)
  params.push(topK)
  return params
}

export function searchGitCommits(db: Database, embedding: Float32Array, topK = 10, projectId?: string): GitCommitHit[] {
  if (!hasVec()) return []
  const embeddingBuf = Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
  const params = buildGitSearchParams(embeddingBuf, topK, projectId)
  const projectFilter = projectId ? `AND g.project_id = ?` : ''
  const rows = db
    .prepare(`
    SELECT v.distance, g.id, g.hash, g.message, g.committed_at, g.author, g.repo
    FROM vec_git_commits v
    LEFT JOIN git_commits g ON v.id = g.id
    WHERE v.embedding MATCH ?
      AND v.k = ?
      ${projectFilter}
    ORDER BY v.distance
    LIMIT ?
  `)
    .all(...params) as (GitCommitHit & { distance: number })[]
  return rows.map(r => ({
    id: r.id,
    hash: r.hash,
    message: r.message,
    committed_at: r.committed_at,
    author: r.author,
    repo: r.repo,
    distance: r.distance,
    similarity: 1 - r.distance
  }))
}
