import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  resolveProject,
  resolveProjectByPath,
  updateProject
} from '../db/projects'
import { getDb } from '../db'
import { ValidationError } from './errors'

export function listProjectsService() {
  return listProjects(getDb())
}

export function getProjectService(id: string) {
  return getProject(getDb(), id) ?? null
}

export function createProjectService(data: {
  name: string
  description?: string
  local_path?: string | null
}) {
  if (!data.name?.trim()) {
    throw new ValidationError('name is required')
  }
  return createProject(getDb(), data)
}

export function updateProjectService(
  id: string,
  data: {
    name?: string
    description?: string | null
    local_path?: string | null
  }
) {
  updateProject(getDb(), id, data)
}

export function deleteProjectService(id: string): boolean {
  return deleteProject(getDb(), id)
}

export function resolveProjectService(cwd: string) {
  return resolveProject(getDb(), cwd) ?? null
}

export function resolveProjectByPathService(cwd: string) {
  return resolveProjectByPath(getDb(), cwd) ?? null
}
