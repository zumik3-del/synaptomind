import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { resolveDefaultProjectId } from './projects'
import { getThoughtTags, getThoughtTagsBatch, pruneOrphanTags, setThoughtTags, type Tag } from './tags'
import { placeholders, toBit } from './utils'

export interface Thought {
  id: string
  content: string
  status: string
  tags: Tag[]
  source: string | null
  project_id: string
  project_name?: string
  is_cluster: number
  is_profile: number
  created_at: string
  updated_at: string
}

export interface CreateThoughtInput {
  content: string
  status?: 'draft' | 'active' | 'archived'
  tags?: string[]
  source?: string
  project_id?: string
  is_cluster?: boolean
  is_profile?: boolean
}

export interface UpdateThoughtInput {
  content?: string
  tags?: string[]
  status?: 'draft' | 'active' | 'archived'
  project_id?: string
  is_cluster?: boolean
  is_profile?: boolean
}

export interface ListThoughtsOptions {
  status?: string
  project_id?: string
  tag?: string
  limit?: number | null
  offset?: number
}

export interface ClusterCandidate {
  id: string
  content: string
  status: string
  tags: Tag[]
  source: string | null
  project_id: string
  created_at: string
}

export function rowToThought(row: Record<string, unknown>): Thought {
  return {
    id: row.id as string,
    content: row.content as string,
    status: row.status as string,
    tags: [],
    source: row.source as string | null,
    project_id: row.project_id as string,
    project_name: row.project_name as string | undefined,
    is_cluster: row.is_cluster as number,
    is_profile: (row.is_profile as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  }
}

const THOUGHT_ROW_SQL =
  'SELECT t.*, p.name as project_name FROM thoughts t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?'

function computeContentHash(content: string, projectId: string): string {
  return createHash('sha256').update(content + projectId).digest('hex')
}

export function getThoughtRow(db: Database, id: string): Thought | undefined {
  const row = db.prepare(THOUGHT_ROW_SQL).get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  return { ...rowToThought(row), tags: getThoughtTags(db, id) }
}

export function parseTags(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw.map(t => t.trim()).filter(Boolean)
  const parsed = raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : undefined
}

export function createThought(db: Database, data: CreateThoughtInput): Thought {
  const run = db.transaction(() => {
    const now = new Date().toISOString()
    const projectId = data.project_id ?? resolveDefaultProjectId(db)
    const contentHash = computeContentHash(data.content, projectId)

    const existing = db
      .prepare(
        `SELECT id FROM thoughts WHERE content_hash = ? AND status IN ('draft', 'active') AND project_id = ? LIMIT 1`
      )
      .get(contentHash, projectId) as { id: string } | undefined

    if (existing) {
      if (data.tags && data.tags.length > 0) {
        setThoughtTags(db, existing.id, data.tags)
      }
      db.prepare(`UPDATE thoughts SET updated_at = ? WHERE id = ?`).run(now, existing.id)
      return existing.id
    }

    const id = uuidv7()
    const isCluster = toBit(data.is_cluster)
    const isProfile = toBit(data.is_profile)

    db.prepare(`
      INSERT INTO thoughts (id, content, status, source, project_id, content_hash, is_cluster, is_profile, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.content, data.status ?? 'draft', data.source ?? null, projectId, contentHash, isCluster, isProfile, now, now)

    if (data.tags && data.tags.length > 0) {
      setThoughtTags(db, id, data.tags)
    }

    return id
  })

  const id = run()
  const row = getThoughtRow(db, id)
  if (!row) throw new Error(`Thought ${id} not found after create`)
  return row
}

export function getThought(db: Database, id: string): Thought | undefined {
  return getThoughtRow(db, id)
}

export function getThoughtsByIds(db: Database, ids: string[]): Map<string, Thought> {
  const map = new Map<string, Thought>()
  if (ids.length === 0) return map
  const ph = placeholders(ids)
  const rows = db
    .prepare(
      `SELECT t.*, p.name as project_name FROM thoughts t LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.id IN (${ph})`
    )
    .all(...ids) as Record<string, unknown>[]
  for (const r of rows) map.set(r.id as string, rowToThought(r))
  return map
}

export function getThoughtsBatchWithTags(db: Database, ids: string[]): Map<string, Thought> {
  const thoughts = getThoughtsByIds(db, ids)
  const tagMap = getThoughtTagsBatch(db, [...thoughts.keys()])
  for (const t of thoughts.values()) t.tags = tagMap.get(t.id) ?? []
  return thoughts
}

export function updateThought(db: Database, id: string, data: UpdateThoughtInput): Thought | undefined {
  const sets: string[] = []
  const values: SQLQueryBindings[] = []

  if (data.content !== undefined) {
    sets.push('content = ?')
    values.push(data.content)
  }
  if (data.tags !== undefined) {
    setThoughtTags(db, id, data.tags)
  }
  if (data.status !== undefined) {
    sets.push('status = ?')
    values.push(data.status)
  }
  if (data.project_id !== undefined) {
    sets.push('project_id = ?')
    values.push(data.project_id)
  }
  if (data.is_cluster !== undefined) {
    sets.push('is_cluster = ?')
    values.push(toBit(data.is_cluster))
  }
  if (data.is_profile !== undefined) {
    sets.push('is_profile = ?')
    values.push(toBit(data.is_profile))
  }

  if (sets.length === 0) {
    return getThoughtRow(db, id)
  }

  sets.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  db.prepare(`UPDATE thoughts SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  return getThoughtRow(db, id)
}

export function archiveThought(db: Database, id: string): Thought | undefined {
  return updateThought(db, id, { status: 'archived' })
}

export function deleteThought(db: Database, id: string): boolean {
  try {
    db.prepare(`DELETE FROM vec_thoughts WHERE id = ?`).run(id)
  } catch {
    // vec_thoughts may not exist (e.g. :memory: tests without vec0)
  }
  const result = db.prepare(`DELETE FROM thoughts WHERE id = ?`).run(id)
  if (result.changes > 0) {
    pruneOrphanTags(db)
  }
  return result.changes > 0
}

export function listThoughts(db: Database, options: ListThoughtsOptions = {}): Thought[] {
  const { status, project_id, tag, limit = 50, offset = 0 } = options

  const where: string[] = []
  const values: SQLQueryBindings[] = []

  if (status && status !== 'all') {
    where.push('t.status = ?')
    values.push(status)
  }
  if (project_id) {
    where.push('t.project_id = ?')
    values.push(project_id)
  }
  if (tag) {
    const tagNames = parseTags(tag)
    if (tagNames && tagNames.length > 0) {
      const placeholders = tagNames.map(() => '?').join(', ')
      where.push(`t.id IN (
        SELECT tt.thought_id FROM thought_tags tt
        INNER JOIN tags tg ON tg.id = tt.tag_id
        WHERE tg.name IN (${placeholders}) COLLATE NOCASE
        GROUP BY tt.thought_id
        HAVING COUNT(DISTINCT tg.name) = ?
      )`)
      values.push(...tagNames, tagNames.length)
    }
  }

  const baseSql = `SELECT t.*, p.name as project_name FROM thoughts t LEFT JOIN projects p ON t.project_id = p.id${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC`
  let sql: string
  let sqlValues: SQLQueryBindings[]
  if (limit === null) {
    // limit=null means "return all" — no LIMIT clause applied
    sql = baseSql
    sqlValues = values
  } else {
    sql = `${baseSql} LIMIT ? OFFSET ?`
    sqlValues = [...values, limit, offset]
  }

  const rows = db.prepare(sql).all(...sqlValues) as Record<string, unknown>[]
  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id as string))
  return rows.map(r => ({ ...rowToThought(r), tags: tagMap.get(r.id as string) ?? [] }))
}

export function listClusterCandidates(db: Database, minAgeDays: number): ClusterCandidate[] {
  const cutoff = new Date(Date.now() - minAgeDays * 86400000).toISOString()
  const rows = db
    .prepare(`
    SELECT t.id, t.content, t.status, t.source, t.project_id, t.created_at
    FROM thoughts t
    WHERE (t.is_cluster IS NULL OR t.is_cluster = 0)
      AND t.status IN ('draft', 'active')
      AND t.created_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.type = 'cluster' AND e.target_id = t.id
      )
    ORDER BY t.created_at DESC
  `)
    .all(cutoff) as {
    id: string
    content: string
    status: string
    source: string | null
    project_id: string
    created_at: string
  }[]
  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id))
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    status: r.status,
    tags: tagMap.get(r.id) ?? [],
    source: r.source,
    project_id: r.project_id,
    created_at: r.created_at
  }))
}

export {
  type ThoughtImportance,
  getThoughtImportance,
  batchGetImportance,
  ensureImportanceRow,
  boostImportance,
  incrementHitCount,
  boostImportanceBatch,
  decayImportance,
  archiveStaleLowImportance
} from './importance'
