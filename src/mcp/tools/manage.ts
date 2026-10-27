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
import { collectionEnvelope, itemEnvelope } from './envelope'
import { createPreviewTokenService, consumePreviewTokenService } from '../../services/preview-tokens.service'

const handlers = {
  list: {
    run(args: ActionArgs) {
      const projects = listProjectsService()
      const fields = args.fields
      const items = Array.isArray(fields) && fields.length > 0
        ? (projects.map((p) => projectFields(p, { fields })) as unknown as typeof projects)
        : projects
      return collectionEnvelope('list', items)
    }
  },

  create: {
    input: z.object({ name: requiredString('name is required for create action') }),
    run(args: ActionArgs) {
      const project = createProjectService({
        name: args.name as string, description: args.description as string | undefined, local_path: args.local_path as string | undefined
      })
      return itemEnvelope('create', project)
    }
  },

  update: {
    input: z.object({ project_id: requiredString('project_id is required for update action') }),
    run(args: ActionArgs) {
      updateProjectService(args.project_id as string, {
        name: args.name as string | undefined, description: args.description as string | undefined, local_path: args.local_path as string | undefined
      })
      return itemEnvelope('update', { success: true, project_id: args.project_id })
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
        return itemEnvelope('delete', {
          action: 'preview',
          project: { id: project.id, name: project.name, description: project.description },
          thought_count: project.thought_count,
          consequence: project.thought_count > 0
            ? `${project.thought_count} thought(s) will be moved to the Default project before deletion.`
            : 'Project has no thoughts — safe to delete.',
          instruction: 'Call memory_manage again with action=delete, project_id=..., confirm=true to proceed.',
          preview_token: token
        })
      }

      const fp = `${project.id}:${project.name}:${project.thought_count}`
      if (!previewToken) throw new Error('preview_token is required')
      const verification = consumePreviewTokenService(previewToken, 'manage_delete', projectId, fp)
      if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)

      const deleted = deleteProjectService(projectId)
      if (!deleted) throw new NotFoundError(`Project not found: ${projectId}`)
      return itemEnvelope('delete', {
        action: 'deleted',
        project: { id: project.id, name: project.name },
        thoughts_moved: project.thought_count,
        moved_to: project.thought_count > 0 ? 'Default project' : undefined
      })
    }
  },

  resolve: {
    input: z.object({ cwd: requiredString('cwd is required for resolve action') }),
    run(args: ActionArgs) {
      const project = resolveProjectService(args.cwd as string)
      if (!project) throw new NotFoundError(`No project found for path: ${args.cwd}`)
      return itemEnvelope('resolve', { id: project.id, name: project.name, local_path: project.local_path })
    }
  }
}

export function registerMemoryManage(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_manage',
    description: `Manage projects (CRUD). Every action answers in one envelope: list returns { items, meta }, the single-project actions return { item, meta }. Actions: list, create, update, delete (preview→confirm), resolve (resolve project from cwd/path).`,
    inputSchema: {
      action: z.enum(['list', 'create', 'update', 'delete', 'resolve']).describe('Action'),
      project_id: z.string().optional().describe('REQUIRED ONLY for "update" and "delete". IGNORED for "list", "create", "resolve".'),
      name: z.string().optional().describe('REQUIRED for "create". OPTIONAL for "update". IGNORED for "list", "delete", "resolve".'),
      description: z.string().optional().describe('Project description. OPTIONAL for "create" and "update". IGNORED for "list", "delete", "resolve".'),
      local_path: z.string().optional().describe('Local filesystem path. OPTIONAL for "create" and "update". IGNORED for "list", "delete", "resolve".'),
      confirm: z.boolean().optional().describe('CONSUMED by "delete" (true executes; false/omitted previews). IGNORED for all other actions.'),
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). IGNORED for all other actions.'),
      cwd: z.string().optional().describe('REQUIRED for "resolve". Working directory path to resolve project from. IGNORED for all other actions.'),
      fields: z.array(z.string()).optional().describe('Fields to include in output; intersected with available columns. OPTIONAL for "list". IGNORED for all other actions.')
    },
    handlers
  })
}
