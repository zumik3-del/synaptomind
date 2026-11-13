import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { ValidationError } from '../errors'
import { insertLog } from '../logging/log'
import { computeContentHash } from '../utils'

export interface Project {
  id: string
  name: string
  description: string | null
  thought_count: number
  created_at: string
  local_path: string | null
}

const PROJECT_WITH_COUNT_SELECT = `
  SELECT p.id, p.name, p.description, p.created_at, COUNT(t.id) as thought_count,
         p.local_path
  FROM projects p
  LEFT JOIN thoughts t ON t.project_id = p.id
`

export const DEFAULT_PROJECT_DELETE_MESSAGE = 'Cannot delete the Default project'

export function listProjects(db: Database): Project[] {
  return db
    .prepare(`${PROJECT_WITH_COUNT_SELECT}
    GROUP BY p.id
    ORDER BY p.name
  `)
    .all() as Project[]
}

export function getProject(db: Database, id: string): Project | undefined {
  const row = db
    .prepare(`${PROJECT_WITH_COUNT_SELECT}
    WHERE p.id = ?
    GROUP BY p.id
  `)
    .get(id) as Project | undefined
  if (!row) return undefined
  return row
}

export function projectExists(db: Database, id: string): boolean {
  return Boolean(db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id))
}

export interface ProjectDeletion {
  deleted: boolean
  moved: number
  archivedIds: string[]
}

export function deleteProject(db: Database, id: string): ProjectDeletion {
  const defaultProjectId = (
    db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
      | { value: string }
      | undefined
  )?.value

  if (defaultProjectId && defaultProjectId === id) {
    throw new ValidationError(DEFAULT_PROJECT_DELETE_MESSAGE)
  }

  const run = db.transaction(() => {
    const moved = defaultProjectId
      ? moveThoughtsToProject(db, id, defaultProjectId)
      : { moved: 0, archivedIds: [] as string[] }
    const result = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    return { deleted: result.changes > 0, ...moved }
  })
  const deletion = run()

  if (deletion.archivedIds.length > 0) {
    insertLog(
      'info',
      'project',
      `Archived ${deletion.archivedIds.length} duplicate thought(s) during deletion of project ${id}`,
      {
        project_id: id,
        archived_count: deletion.archivedIds.length,
        archived_ids: deletion.archivedIds
      }
    )
  }
  return deletion
}

interface MovingThought {
  id: string
  content: string
  status: string
  created_at: string
}

interface LiveThought {
  id: string
  content: string
  created_at: string
}

function moveThoughtsToProject(
  db: Database,
  fromId: string,
  toId: string
): { moved: number; archivedIds: string[] } {
  const moved = db
    .prepare(`SELECT id, content, status, created_at FROM thoughts WHERE project_id = ?`)
    .all(fromId) as MovingThought[]

  if (moved.length === 0) return { moved: 0, archivedIds: [] }

  const archivedIds = archiveContentCollisions(
    db,
    toId,
    moved.filter(thought => thought.status === 'draft' || thought.status === 'active')
  )

  const move = db.prepare(`UPDATE thoughts SET project_id = ?, content_hash = ? WHERE id = ?`)
  for (const thought of moved) {
    move.run(toId, computeContentHash(thought.content, toId), thought.id)
  }
  return { moved: moved.length, archivedIds }
}

// v046's rule for the merge: the oldest live row per content survives, later ones are archived.
// The pass runs before the hashes are written, because they collide only once recomputed.
// Only destination rows sharing a moved row's content can collide, so the scan is narrowed to them.
function archiveContentCollisions(db: Database, toId: string, moved: LiveThought[]): string[] {
  if (moved.length === 0) return []

  const contents = JSON.stringify([...new Set(moved.map(thought => thought.content))])
  const settled = db
    .prepare(
      `SELECT id, content, created_at FROM thoughts
       WHERE project_id = ? AND status IN ('draft', 'active')
         AND content IN (SELECT value FROM json_each(?))`
    )
    .all(toId, contents) as LiveThought[]

  const groups = new Map<string, LiveThought[]>()
  for (const thought of [...settled, ...moved]) {
    const group = groups.get(thought.content)
    if (group) group.push(thought)
    else groups.set(thought.content, [thought])
  }

  const now = new Date().toISOString()
  // is_protected stays set on purpose: retention review purges archived rows only when it is 0.
  const archive = db.prepare(
    `UPDATE thoughts SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`
  )
  const archivedIds: string[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const duplicate of group.sort(oldestFirst).slice(1)) {
      archive.run(now, now, duplicate.id)
      archivedIds.push(duplicate.id)
    }
  }
  return archivedIds
}

function oldestFirst(a: LiveThought, b: LiveThought): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

export function isDefaultProject(db: Database, id: string): boolean {
  const defaultProjectId = (
    db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
      | { value: string }
      | undefined
  )?.value
  return defaultProjectId === id
}

export function createProject(
  db: Database,
  data: {
    name: string
    description?: string
    local_path?: string | null
  }
): Project {
  const id = Bun.randomUUIDv7()
  db.prepare(
    `INSERT INTO projects (id, name, description, created_at, local_path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    data.name,
    data.description ?? null,
    new Date().toISOString(),
    normalizePath(data.local_path)
  )
  const project = getProject(db, id)
  if (!project) throw new Error(`Project ${id} not found after insert`)
  return project
}

export function updateProject(
  db: Database,
  id: string,
  data: {
    name?: string
    description?: string | null
    local_path?: string | null
  }
): void {
  const sets: string[] = []
  const values: SQLQueryBindings[] = []
  if (data.name !== undefined) {
    sets.push('name = ?')
    values.push(data.name)
  }
  if (data.description !== undefined) {
    sets.push('description = ?')
    values.push(data.description)
  }
  if (data.local_path !== undefined) {
    sets.push('local_path = ?')
    values.push(normalizePath(data.local_path))
  }
  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function resolveDefaultProjectId(db: Database): string {
  const existing = db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
    | { value: string }
    | undefined
  if (existing?.value) {
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`
    ).run(existing.value, new Date().toISOString())
    return existing.value
  }
  const id = Bun.randomUUIDv7()
  db.prepare(`INSERT INTO _meta (key, value) VALUES ('default_project_id', ?)`).run(id)
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(
    id,
    new Date().toISOString()
  )
  return id
}

function normalizePath(p: string | null | undefined): string | null {
  if (!p) return null
  return p.replace(/\/+$/, '').replace(/\\/g, '/')
}

function resolveProjectByPath(db: Database, cwd: string): Project | undefined {
  const normalized = normalizePath(cwd)
  if (!normalized) return undefined
  return db
    .prepare(`${PROJECT_WITH_COUNT_SELECT}
    WHERE p.local_path = ?
    GROUP BY p.id
  `)
    .get(normalized) as Project | undefined
}

export function resolveProject(db: Database, cwd: string): Project | undefined {
  return resolveProjectByPath(db, cwd)
}
