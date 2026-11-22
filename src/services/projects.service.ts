import {
  archiveThoughtRow,
  createProject,
  deleteProjectRow,
  getDefaultProjectId,
  getProject,
  isDefaultProject,
  listLiveThoughtsByContents,
  listProjectThoughts,
  listProjects,
  moveThoughtToProject,
  type ProjectDeletion,
  type ProjectThoughtRow,
  resolveProject,
  updateProject
} from '../db/projects'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import { insertLog } from '../logging/log'
import { computeContentHash } from '../utils'
import type { Database } from 'bun:sqlite'

export type { ProjectDeletion } from '../db/projects'

export const DEFAULT_PROJECT_DELETE_MESSAGE = 'Cannot delete the Default project'

export function isDefaultProjectService(id: string, d: Database = getDb()): boolean {
  return isDefaultProject(d, id)
}

export function listProjectsService(d: Database = getDb()) {
  return listProjects(d)
}

export function getProjectService(id: string, d: Database = getDb()) {
  return getProject(d, id) ?? null
}

export function createProjectService(
  data: {
    name: string
    description?: string
    local_path?: string | null
  },
  d: Database = getDb()
) {
  if (!data.name?.trim()) {
    throw new ValidationError('name is required')
  }
  return createProject(d, data)
}

export function updateProjectService(
  id: string,
  data: {
    name?: string
    description?: string | null
    local_path?: string | null
  },
  d: Database = getDb()
) {
  updateProject(d, id, data)
}

export function deleteProject(d: Database, id: string): ProjectDeletion {
  const defaultProjectId = getDefaultProjectId(d)

  if (defaultProjectId && defaultProjectId === id) {
    throw new ValidationError(DEFAULT_PROJECT_DELETE_MESSAGE)
  }

  const run = d.transaction(() => {
    const moved = defaultProjectId
      ? moveThoughtsToProject(d, id, defaultProjectId)
      : { moved: 0, archivedIds: [] as string[] }
    return { deleted: deleteProjectRow(d, id), ...moved }
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

function moveThoughtsToProject(
  d: Database,
  fromId: string,
  toId: string
): { moved: number; archivedIds: string[] } {
  const moved = listProjectThoughts(d, fromId)

  if (moved.length === 0) return { moved: 0, archivedIds: [] }

  const archivedIds = archiveContentCollisions(
    d,
    toId,
    moved.filter(thought => thought.status === 'draft' || thought.status === 'active')
  )

  for (const thought of moved) {
    moveThoughtToProject(d, thought.id, toId, computeContentHash(thought.content, toId))
  }
  return { moved: moved.length, archivedIds }
}

// v046's rule for the merge: the oldest live row per content survives, later ones are archived.
// The pass runs before the hashes are written, because they collide only once recomputed.
// Only destination rows sharing a moved row's content can collide, so the scan is narrowed to them.
function archiveContentCollisions(d: Database, toId: string, moved: ProjectThoughtRow[]): string[] {
  if (moved.length === 0) return []

  const settled = listLiveThoughtsByContents(
    d,
    toId,
    moved.map(thought => thought.content)
  )

  const groups = new Map<string, ProjectThoughtRow[]>()
  for (const thought of [...settled, ...moved]) {
    const group = groups.get(thought.content)
    if (group) group.push(thought)
    else groups.set(thought.content, [thought])
  }

  const now = new Date().toISOString()
  // is_protected stays set on purpose: retention review purges archived rows only when it is 0.
  const archivedIds: string[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const duplicate of group.sort(oldestFirst).slice(1)) {
      archiveThoughtRow(d, duplicate.id, now)
      archivedIds.push(duplicate.id)
    }
  }
  return archivedIds
}

function oldestFirst(a: ProjectThoughtRow, b: ProjectThoughtRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

export function deleteProjectService(id: string, d: Database = getDb()): ProjectDeletion {
  return deleteProject(d, id)
}

export function resolveProjectService(cwd: string, d: Database = getDb()) {
  return resolveProject(d, cwd) ?? null
}
