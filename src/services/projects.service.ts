import { createProject, deleteProject, getProject, listProjects, updateProject } from '../db/projects'
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
  is_git_linked?: boolean
  git_repo_url?: string | null
  git_auto_sync?: boolean
  git_sync_interval_ms?: number | null
}) {
  if (!data.name?.trim()) {
    throw new ValidationError('name is required')
  }
  if (data.is_git_linked && !data.git_repo_url?.trim()) {
    throw new ValidationError('git_repo_url is required when the project is git-linked')
  }
  return createProject(getDb(), data)
}

export function updateProjectService(
  id: string,
  data: {
    name?: string
    description?: string | null
    is_git_linked?: boolean
    git_repo_url?: string | null
    git_auto_sync?: boolean
    git_sync_interval_ms?: number | null
  }
) {
  updateProject(getDb(), id, data)
}

export function deleteProjectService(id: string): boolean {
  return deleteProject(getDb(), id)
}
