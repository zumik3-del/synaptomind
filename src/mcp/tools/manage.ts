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
import { projectFields } from './utils'
import { createPreviewTokenService, verifyPreviewTokenService, consumePreviewTokenService } from '../../services/preview-tokens.service'

const handlers = {
  list: {
    run(args: ActionArgs) {
      const projects = listProjectsService()
      const fields = args.fields
      if (Array.isArray(fields) && fields.length > 0) {
        return projects.map((p: any) => projectFields(p, { fields }))
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
    input: z.object({ project_id: requiredString('project_id is required for delete action'), preview_token: z.string().optional() }),
    run(args: ActionArgs) {
      const projectId = args.project_id as string
      const previewToken = args.preview_token as string | undefined
      const project = getProjectService(projectId)
      if (!project) throw new NotFoundError(`Project not found: ${projectId}`)
      if (isDefaultProjectService(projectId)) throw new ValidationError(DEFAULT_PROJECT_DELETE_MESSAGE)

      if (!args.confirm) {
        const token = createPreviewTokenService('manage_delete', projectId, `${project.id}:${project.name}:${project.thought_count}`)
        return {
          action: 'preview',
          project: { id: project.id, name: project.name, description: project.description },
          thought_count: project.thought_count,
          consequence: project.thought_count > 0
            ? `${project.thought_count} thought(s) will be moved to the Default project before deletion.`
            : 'Project has no thoughts — safe to delete.',
          instruction: 'Call memory_manage again with action=delete, project_id=..., confirm=true to proceed.',
          preview_token: token
        }
      }

      const fp = `${project.id}:${project.name}:${project.thought_count}`
      if (!previewToken) throw new Error('preview_token is required')
      const verification = verifyPreviewTokenService(previewToken, 'manage_delete', projectId, fp)
      if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
      consumePreviewTokenService(previewToken)

      const deleted = deleteProjectService(projectId)
      if (!deleted) throw new NotFoundError(`Project not found: ${projectId}`)
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
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). IGNORED for all other actions.'),
      cwd: z.string().optional().describe('REQUIRED for "resolve". Working directory path to resolve project from. IGNORED for all other actions.'),
      compact: z.boolean().optional().describe('Compact output: trim to minimal fields (id, content, status, tags as strings, project). OPTIONAL for "list". IGNORED for all other actions.'),
      fields: z.array(z.string()).optional().describe('Fields to include in output; intersected with available columns. OPTIONAL for "list". IGNORED for all other actions.')
    },
    handlers
  })
}
