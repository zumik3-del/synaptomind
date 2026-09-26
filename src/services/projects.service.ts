import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  resolveProject,
  updateProject
} from '../db/projects'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import type { Database } from 'bun:sqlite'

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

export function deleteProjectService(id: string, d: Database = getDb()): boolean {
  return deleteProject(d, id)
}

export function resolveProjectService(cwd: string, d: Database = getDb()) {
  return resolveProject(d, cwd) ?? null
}
