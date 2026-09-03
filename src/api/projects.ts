import { Hono } from 'hono'
import { ValidationError } from '../services/errors'
import {
  createProjectService,
  deleteProjectService,
  getProjectService,
  listProjectsService,
  resolveProjectService,
  updateProjectService
} from '../services/projects.service'

const projectsRouter = new Hono()

projectsRouter.get('/', c => c.json(listProjectsService()))

projectsRouter.get('/resolve', c => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path query parameter is required' }, 400)
  const project = resolveProjectService(path)
  if (!project) return c.json({ error: 'No project found for path' }, 404)
  return c.json({ id: project.id, name: project.name, local_path: project.local_path })
})

projectsRouter.post('/', async c => {
  const body = await c.req.json<{
    name: string
    description?: string
    is_git_linked?: boolean
    git_repo_url?: string | null
    git_auto_sync?: boolean
    git_sync_interval_ms?: number | null
    local_path?: string | null
  }>()
  try {
    return c.json(createProjectService(body), 201)
  } catch (err: unknown) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    throw err
  }
})

projectsRouter.patch('/:id', async c => {
  const id = c.req.param('id')
  const existing = getProjectService(id)
  if (!existing) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{
    name?: string
    description?: string | null
    is_git_linked?: boolean
    git_repo_url?: string | null
    git_auto_sync?: boolean
    git_sync_interval_ms?: number | null
    local_path?: string | null
  }>()
  updateProjectService(id, body)
  return c.json({ success: true })
})

projectsRouter.get('/:id', c => {
  const project = getProjectService(c.req.param('id'))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return c.json(project)
})

projectsRouter.delete('/:id', c => {
  const deleted = deleteProjectService(c.req.param('id'))
  if (!deleted) return c.json({ error: 'Project not found' }, 404)
  return c.json({ success: true })
})

export { projectsRouter }
