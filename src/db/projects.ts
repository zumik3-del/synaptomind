import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'

export interface Project {
  id: string
  name: string
  description: string | null
  thought_count: number
  created_at: string
  local_path: string | null
}

export function listProjects(db: Database): Project[] {
  return db
    .prepare(`
    SELECT p.id, p.name, p.description, p.created_at, COUNT(t.id) as thought_count,
           p.local_path
    FROM projects p
    LEFT JOIN thoughts t ON t.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `)
    .all() as Project[]
}

export function getProject(db: Database, id: string): Project | undefined {
  const row = db
    .prepare(`
    SELECT p.id, p.name, p.description, p.created_at, COUNT(t.id) as thought_count,
           p.local_path
    FROM projects p
    LEFT JOIN thoughts t ON t.project_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `)
    .get(id) as Project | undefined
  if (!row) return undefined
  return row
}

export function deleteProject(db: Database, id: string): boolean {
  const defaultProjectId = (
    db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as { value: string } | undefined
  )?.value

  if (defaultProjectId && defaultProjectId === id) {
    throw new Error('Cannot delete the Default project')
  }

  if (defaultProjectId) {
    db.prepare(`UPDATE thoughts SET project_id = ? WHERE project_id = ?`).run(defaultProjectId, id)
  }
  const result = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  return result.changes > 0
}

export function createProject(db: Database, data: {
  name: string
  description?: string
  local_path?: string | null
}): Project {
  const id = uuidv7()
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
  return (
    getProject(db, id) ?? {
      ...({ id, name: data.name, description: data.description ?? null, created_at: '' } as Project),
      thought_count: 0
    }
  )
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
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(
      existing.value,
      new Date().toISOString()
    )
    return existing.value
  }
  const id = crypto.randomUUID()
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

export function resolveProjectByPath(db: Database, cwd: string): Project | undefined {
  const normalized = normalizePath(cwd)
  if (!normalized) return undefined
  return db
    .prepare(`
    SELECT p.id, p.name, p.description, p.created_at, COUNT(t.id) as thought_count,
           p.local_path
    FROM projects p
    LEFT JOIN thoughts t ON t.project_id = p.id
    WHERE p.local_path = ?
    GROUP BY p.id
  `)
    .get(normalized) as Project | undefined
}

export function resolveProject(db: Database, cwd: string): Project | undefined {
  return resolveProjectByPath(db, cwd)
}
