import { Hono } from 'hono'
import { NotFoundError } from '../errors'
import { withTelemetry } from '../logging'
import {
  createProjectService,
  deleteProjectService,
  getProjectService,
  listProjectsService,
  resolveProjectService,
  updateProjectService
} from '../services/projects.service'

const projectsRouter = new Hono()

projectsRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_projects' }, c2 => c2.json(listProjectsService()))
})

projectsRouter.get('/resolve', c => {
  return withTelemetry(c, { action: 'read', toolName: 'resolve_project' }, c2 => {
    const path = c2.req.query('path')
    if (!path) return c2.json({ error: 'path query parameter is required' }, 400)
    const project = resolveProjectService(path)
    if (!project) throw new NotFoundError('No project found for path')
    return c2.json({ id: project.id, name: project.name, local_path: project.local_path })
  })
})

projectsRouter.post('/', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'create_project' }, async c2 => {
    const body = await c2.req.json<{
      name: string
      description?: string
      local_path?: string | null
    }>()
    return c2.json(createProjectService(body), 201)
  })
})

projectsRouter.patch('/:id', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'update_project' }, async c2 => {
    const id = c2.req.param('id')!
    const existing = getProjectService(id)
    if (!existing) throw new NotFoundError('Project not found')
    const body = await c2.req.json<{
      name?: string
      description?: string | null
      local_path?: string | null
    }>()
    updateProjectService(id, body)
    return c2.json({ success: true })
  })
})

projectsRouter.get('/:id', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_project' }, c2 => {
    const project = getProjectService(c2.req.param('id')!)
    if (!project) throw new NotFoundError('Project not found')
    return c2.json(project)
  })
})

projectsRouter.delete('/:id', c => {
  return withTelemetry(c, { action: 'write', toolName: 'delete_project' }, c2 => {
    const deleted = deleteProjectService(c2.req.param('id')!)
    if (!deleted) throw new NotFoundError('Project not found')
    return c2.json({ success: true })
  })
})

export { projectsRouter }
