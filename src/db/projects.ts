import type { Database, SQLQueryBindings } from 'bun:sqlite'

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

export function getDefaultProjectId(db: Database): string | undefined {
  return (
    db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
      | { value: string }
      | undefined
  )?.value
}

export function deleteProjectRow(db: Database, id: string): boolean {
  return db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0
}

export interface ProjectThoughtRow {
  id: string
  content: string
  status: string
  created_at: string
}

export function listProjectThoughts(db: Database, projectId: string): ProjectThoughtRow[] {
  return db
    .prepare(`SELECT id, content, status, created_at FROM thoughts WHERE project_id = ?`)
    .all(projectId) as ProjectThoughtRow[]
}

export function listLiveThoughtsByContents(
  db: Database,
  projectId: string,
  contents: string[]
): ProjectThoughtRow[] {
  return db
    .prepare(
      `SELECT id, content, status, created_at FROM thoughts
       WHERE project_id = ? AND status IN ('draft', 'active')
         AND content IN (SELECT value FROM json_each(?))`
    )
    .all(projectId, JSON.stringify(contents)) as ProjectThoughtRow[]
}

export function moveThoughtToProject(
  db: Database,
  thoughtId: string,
  toProjectId: string,
  contentHash: string
): void {
  db.prepare(`UPDATE thoughts SET project_id = ?, content_hash = ? WHERE id = ?`).run(
    toProjectId,
    contentHash,
    thoughtId
  )
}

export function archiveThoughtRow(db: Database, id: string, archivedAt: string): void {
  db.prepare(
    `UPDATE thoughts SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`
  ).run(archivedAt, archivedAt, id)
}

export function isDefaultProject(db: Database, id: string): boolean {
  return getDefaultProjectId(db) === id
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
  const existing = getDefaultProjectId(db)
  if (existing) {
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`
    ).run(existing, new Date().toISOString())
    return existing
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
