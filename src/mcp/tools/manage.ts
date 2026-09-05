import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  listProjectsService,
  createProjectService,
  updateProjectService,
  deleteProjectService,
  getProjectService,
  resolveProjectService
} from '../../services/projects.service'
import { jsonResult, errorResult } from './utils'

type ManageArgs = Record<string, unknown>

const actionHandlers: Record<string, (args: ManageArgs) => unknown> = {
  list() {
    return listProjectsService()
  },

  create(args) {
    if (!args.name) throw new Error('name is required for create action')
    return createProjectService({
      name: args.name as string, description: args.description as string | undefined, local_path: args.local_path as string | undefined
    })
  },

  update(args) {
    if (!args.project_id) throw new Error('project_id is required for update action')
    updateProjectService(args.project_id as string, {
      name: args.name as string | undefined, description: args.description as string | undefined, local_path: args.local_path as string | undefined
    })
    return { success: true, project_id: args.project_id }
  },

  delete(args) {
    if (!args.project_id) throw new Error('project_id is required for delete action')
    const project = getProjectService(args.project_id as string)
    if (!project) throw new Error(`Project not found: ${args.project_id}`)
    if (project.name === 'Default') throw new Error('Cannot delete the Default project.')

    if (!args.confirm) {
      return {
        action: 'preview',
        project: { id: project.id, name: project.name, description: project.description },
        thought_count: project.thought_count,
        consequence: project.thought_count > 0
          ? `${project.thought_count} thought(s) will be moved to the Default project before deletion.`
          : 'Project has no thoughts — safe to delete.',
        instruction: 'Call memory_manage again with action=delete, project_id=..., confirm=true to proceed.'
      }
    }

    const deleted = deleteProjectService(args.project_id as string)
    if (!deleted) throw new Error(`Failed to delete project: ${args.project_id}`)
    return {
      action: 'deleted',
      project: { id: project.id, name: project.name },
      thoughts_moved: project.thought_count,
      moved_to: project.thought_count > 0 ? 'Default project' : undefined
    }
  },

  resolve(args) {
    if (!args.cwd) throw new Error('cwd is required for resolve action')
    const project = resolveProjectService(args.cwd as string)
    if (!project) throw new Error(`No project found for path: ${args.cwd}`)
    return { id: project.id, name: project.name, local_path: project.local_path }
  }
}

export function registerMemoryManage(server: McpServer) {
  server.tool('memory_manage', `Manage projects. Actions:
- list: List all projects
- create: Create a new project
- update: Update a project
- delete: Delete a project (preview first with confirm=false, then confirm=true)
- resolve: Resolve project from a filesystem path`, {
    action: z.enum(['list', 'create', 'update', 'delete', 'resolve']).describe('Action'),
    project_id: z.string().optional().describe('REQUIRED ONLY for "update" and "delete". IGNORED for "list", "create", "resolve".'),
    name: z.string().optional().describe('REQUIRED for "create". OPTIONAL for "update". IGNORED for "list", "delete", "resolve".'),
    description: z.string().optional().describe('Project description (for create/update)'),
    local_path: z.string().optional().describe('Local filesystem path (for create/update)'),
    confirm: z.boolean().optional().describe('Set to true to actually delete. Set to false to preview first.'),
    cwd: z.string().optional().describe('REQUIRED ONLY for "resolve". Working directory path to resolve project from.')
  }, async (args) => {
    try {
      const handler = actionHandlers[args.action as string]
      if (!handler) return errorResult(`Unknown action: ${args.action}`)
      return jsonResult(handler(args))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_manage failed')
    }
  })
}
