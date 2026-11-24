import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
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
import {
  DESTRUCTIVE,
  actionInput,
  registerActionTool,
  requiredString,
  type ActionArgs
} from './action-tool'
import { shapeEntity } from './utils'
import { collectionEnvelope, itemEnvelope } from './envelope'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'

const MANAGE_ARGS = {
  project_id: z
    .string()
    .optional()
    .describe('REQUIRED ONLY for "update" and "delete". REJECTED for "list", "create", "resolve".'),
  name: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "create". OPTIONAL for "update". REJECTED for "list", "delete", "resolve".'
    ),
  description: z
    .string()
    .optional()
    .describe(
      'Project description. OPTIONAL for "create" and "update". REJECTED for "list", "delete", "resolve".'
    ),
  local_path: z
    .string()
    .optional()
    .describe(
      'Local filesystem path. OPTIONAL for "create" and "update". REJECTED for "list", "delete", "resolve".'
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'CONSUMED by "delete" (true executes; false/omitted previews). REJECTED for all other actions.'
    ),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). REJECTED for all other actions.'
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "resolve": the working directory path to resolve. ACCEPTED AND IGNORED for all other actions.'
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Fields to include in output; intersected with available columns. OPTIONAL for "list". REJECTED for all other actions.'
    )
}

const handlers = {
  list: {
    input: actionInput(MANAGE_ARGS, ['fields']),
    run(args: ActionArgs) {
      const projects = listProjectsService()
      const items = projects.map(p => shapeEntity(p, { compact: false, fields: args.fields }))
      return collectionEnvelope('list', items as unknown as typeof projects)
    }
  },

  create: {
    input: actionInput(MANAGE_ARGS, ['name', 'description', 'local_path'], {
      name: requiredString('name is required for create action')
    }),
    run(args: ActionArgs) {
      const project = createProjectService({
        name: args.name as string,
        description: args.description as string | undefined,
        local_path: args.local_path as string | undefined
      })
      return itemEnvelope('create', project)
    }
  },

  update: {
    input: actionInput(MANAGE_ARGS, ['project_id', 'name', 'description', 'local_path'], {
      project_id: requiredString('project_id is required for update action')
    }),
    run(args: ActionArgs) {
      updateProjectService(args.project_id as string, {
        name: args.name as string | undefined,
        description: args.description as string | undefined,
        local_path: args.local_path as string | undefined
      })
      return itemEnvelope('update', { success: true, project_id: args.project_id })
    }
  },

  delete: {
    input: actionInput(MANAGE_ARGS, ['project_id', 'confirm', 'preview_token'], {
      project_id: requiredString('project_id is required for delete action')
    }),
    async run(args: ActionArgs) {
      const projectId = args.project_id as string
      const project = getProjectService(projectId)
      if (!project) throw new NotFoundError(`Project not found: ${projectId}`)
      if (isDefaultProjectService(projectId))
        throw new ValidationError(DEFAULT_PROJECT_DELETE_MESSAGE)

      const outcome = await runGuarded(args, {
        kind: 'manage_delete',
        targetId: projectId,
        fingerprint: () => fingerprintOf(project.id, project.name, project.thought_count),
        preview: token =>
          itemEnvelope(
            'delete',
            {
              action: 'preview',
              project: { id: project.id, name: project.name, description: project.description },
              thought_count: project.thought_count,
              consequence:
                project.thought_count > 0
                  ? `${project.thought_count} thought(s) will be moved to the Default project before deletion; any whose content is already live there will be archived, not kept live.`
                  : 'Project has no thoughts — safe to delete.',
              instruction:
                'Call memory_manage again with action=delete, project_id=..., confirm=true to proceed.'
            },
            { preview: { token } }
          ),
        apply: () => {
          const deletion = deleteProjectService(projectId)
          if (!deletion.deleted) throw new NotFoundError(`Project not found: ${projectId}`)
          return {
            action: 'deleted',
            project: { id: project.id, name: project.name },
            thoughts_moved: deletion.moved,
            moved_to: deletion.moved > 0 ? 'Default project' : undefined,
            thoughts_archived: deletion.archivedIds.length,
            archived_thought_ids: deletion.archivedIds
          }
        }
      })

      return outcome.value
    }
  },

  resolve: {
    input: actionInput(MANAGE_ARGS, ['cwd'], {
      cwd: requiredString('cwd is required for resolve action')
    }),
    run(args: ActionArgs) {
      const project = resolveProjectService(args.cwd as string)
      if (!project) throw new NotFoundError(`No project found for path: ${args.cwd}`)
      return itemEnvelope('resolve', {
        id: project.id,
        name: project.name,
        local_path: project.local_path
      })
    }
  }
}

export function registerMemoryManage(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_manage',
    annotations: DESTRUCTIVE,
    description: `Manage projects — the containers thoughts belong to; the thoughts themselves are memory_recall and their writes memory_store. Every action answers in one envelope: list returns { items, meta }, the single-project actions return { item, meta }. Actions: list, create, update, delete (preview→confirm), resolve (resolve project from cwd/path). Actions accept only their own arguments.`,
    inputSchema: {
      action: z.enum(['list', 'create', 'update', 'delete', 'resolve']).describe('Action'),
      ...MANAGE_ARGS
    },
    handlers
  })
}
