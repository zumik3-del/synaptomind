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
  is_git_linked?: boolean
  git_repo_url?: string | null
  git_auto_sync?: boolean
  git_sync_interval_ms?: number | null
  local_path?: string | null
}) {
  if (!data.name?.trim()) {
    throw new ValidationError('name is required')
  }
  const normalized = { ...data }
  if (normalized.is_git_linked === undefined && normalized.git_repo_url !== undefined) {
    normalized.is_git_linked = Boolean(normalized.git_repo_url?.trim())
  }
  if (normalized.is_git_linked && !normalized.git_repo_url?.trim()) {
    throw new ValidationError('git_repo_url is required when the project is git-linked')
  }
  return createProject(getDb(), normalized)
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
    local_path?: string | null
  }
) {
  const db = getDb()
  const normalized = { ...data }
  if (normalized.is_git_linked === undefined && normalized.git_repo_url !== undefined) {
    normalized.is_git_linked = Boolean(normalized.git_repo_url?.trim())
  }

  const existing = getProject(db, id)
  const effectiveRepoUrl = normalized.git_repo_url !== undefined
    ? normalized.git_repo_url
    : existing?.git_repo_url
  if (normalized.is_git_linked && !effectiveRepoUrl?.trim()) {
    throw new ValidationError('git_repo_url is required when the project is git-linked')
  }

  updateProject(db, id, normalized)
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
