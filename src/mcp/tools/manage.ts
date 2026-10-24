import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NotFoundError, ValidationError } from '../../errors'
import {
  listProjectsService,
  createProjectService,
  updateProjectService,
  deleteProjectService,
  getProjectService,
  resolveProjectService,
  isDefaultProjectService,
  DEFAULT_PROJECT_DELETE_MESSAGE
} from '../../services/projects.service'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'
import { pickFields } from './utils'

const handlers = {
  list: {
    run(args: ActionArgs) {
      const projects = listProjectsService()
      const fields = args.fields
      if (Array.isArray(fields) && fields.length > 0) {
        return projects.map((p: any) => pickFields(p, { fields }))
      }
      return projects
    }
  },

  create: {
    input: z.object({ name: requiredString('name is required for create action') }),
    run(args: ActionArgs) {
      return createProjectService({
        name: args.name as string, description: args.description as string | undefined, local_path: args.local_path as string | undefined
      })
    }
  },

  update: {
    input: z.object({ project_id: requiredString('project_id is required for update action') }),
    run(args: ActionArgs) {
      updateProjectService(args.project_id as string, {
        name: args.name as string | undefined, description: args.description as string | undefined, local_path: args.local_path as string | undefined
      })
      return { success: true, project_id: args.project_id }
    }
  },

  delete: {
    input: z.object({ project_id: requiredString('project_id is required for delete action') }),
    run(args: ActionArgs) {
      const project = getProjectService(args.project_id as string)
      if (!project) throw new NotFoundError(`Project not found: ${args.project_id}`)
      if (isDefaultProjectService(args.project_id as string)) throw new ValidationError(DEFAULT_PROJECT_DELETE_MESSAGE)

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
      if (!deleted) throw new NotFoundError(`Project not found: ${args.project_id}`)
      return {
        action: 'deleted',
        project: { id: project.id, name: project.name },
        thoughts_moved: project.thought_count,
        moved_to: project.thought_count > 0 ? 'Default project' : undefined
      }
    }
  },

  resolve: {
    input: z.object({ cwd: requiredString('cwd is required for resolve action') }),
    run(args: ActionArgs) {
      const project = resolveProjectService(args.cwd as string)
      if (!project) throw new NotFoundError(`No project found for path: ${args.cwd}`)
      return { id: project.id, name: project.name, local_path: project.local_path }
    }
  }
}

export function registerMemoryManage(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_manage',
    description: `Manage projects (CRUD). Actions: list, create, update, delete (preview→confirm), resolve (resolve project from cwd/path).`,
    inputSchema: {
      action: z.enum(['list', 'create', 'update', 'delete', 'resolve']).describe('Action'),
      project_id: z.string().optional().describe('REQUIRED ONLY for "update" and "delete". IGNORED for "list", "create", "resolve".'),
      name: z.string().optional().describe('REQUIRED for "create". OPTIONAL for "update". IGNORED for "list", "delete", "resolve".'),
      description: z.string().optional().describe('Project description. OPTIONAL for "create" and "update". IGNORED for "list", "delete", "resolve".'),
      local_path: z.string().optional().describe('Local filesystem path. OPTIONAL for "create" and "update". IGNORED for "list", "delete", "resolve".'),
      confirm: z.boolean().optional().describe('CONSUMED by "delete" (true executes; false/omitted previews). IGNORED for all other actions.'),
      cwd: z.string().optional().describe('REQUIRED for "resolve". Working directory path to resolve project from. IGNORED for all other actions.'),
      compact: z.boolean().optional().describe('Compact output: trim to minimal fields (id, content, status, tags as strings, project). OPTIONAL for "list". IGNORED for all other actions.'),
      fields: z.array(z.string()).optional().describe('Fields to include in output; intersected with available columns. OPTIONAL for "list". IGNORED for all other actions.')
    },
    handlers
  })
}
