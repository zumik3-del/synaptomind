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

export function registerMemoryManage(server: McpServer) {
  server.tool('memory_manage', `Manage projects. Actions:
- list: List all projects
- create: Create a new project
- update: Update a project
- delete: Delete a project (preview first with confirm=false, then confirm=true)
- resolve: Resolve project from a filesystem path`, {
    action: z.enum(['list', 'create', 'update', 'delete', 'resolve']).describe('Action'),
    project_id: z.string().optional().describe('Project ID (required for update/delete)'),
    name: z.string().optional().describe('Project name (required for create, optional for update)'),
    description: z.string().optional().describe('Project description'),
    local_path: z.string().optional().describe('Local filesystem path for auto-resolution from cwd'),
    git_repo_url: z.string().optional().describe('Git repo URL (HTTPS or SSH)'),
    is_git_linked: z.boolean().optional().describe('Mark project as git-linked'),
    git_auto_sync: z.boolean().optional().describe('Enable auto-sync for git-linked project'),
    git_sync_interval_ms: z.number().int().positive().optional().describe('Git sync interval in milliseconds'),
    confirm: z.boolean().optional().describe('Set to true to actually delete. Set to false to preview first.'),
    cwd: z.string().optional().describe('Working directory path to resolve project from')
  }, async (args) => {
    try {
      if (args.action === 'list') {
        const projects = listProjectsService()
        return jsonResult(projects)
      }

      if (args.action === 'create') {
        if (!args.name) return errorResult('name is required for create action')
        const project = createProjectService({
          name: args.name, description: args.description, local_path: args.local_path,
          git_repo_url: args.git_repo_url, is_git_linked: args.is_git_linked,
          git_auto_sync: args.git_auto_sync, git_sync_interval_ms: args.git_sync_interval_ms
        })
        return jsonResult(project)
      }

      if (args.action === 'update') {
        if (!args.project_id) return errorResult('project_id is required for update action')
        updateProjectService(args.project_id, {
          name: args.name, description: args.description, local_path: args.local_path,
          git_repo_url: args.git_repo_url, is_git_linked: args.is_git_linked,
          git_auto_sync: args.git_auto_sync, git_sync_interval_ms: args.git_sync_interval_ms
        })
        return jsonResult({ success: true, project_id: args.project_id })
      }

      if (args.action === 'delete') {
        if (!args.project_id) return errorResult('project_id is required for delete action')
        const project = getProjectService(args.project_id)
        if (!project) return errorResult(`Project not found: ${args.project_id}`)
        if (project.name === 'Default') return errorResult('Cannot delete the Default project.')

        if (!args.confirm) {
          return jsonResult({
            action: 'preview',
            project: { id: project.id, name: project.name, description: project.description },
            thought_count: project.thought_count,
            consequence: project.thought_count > 0
              ? `${project.thought_count} thought(s) will be moved to the Default project before deletion.`
              : 'Project has no thoughts — safe to delete.',
            instruction: 'Call memory_manage again with action=delete, project_id=..., confirm=true to proceed.'
          })
        }

        const deleted = deleteProjectService(args.project_id)
        if (!deleted) return errorResult(`Failed to delete project: ${args.project_id}`)
        return jsonResult({
          action: 'deleted',
          project: { id: project.id, name: project.name },
          thoughts_moved: project.thought_count,
          moved_to: project.thought_count > 0 ? 'Default project' : undefined
        })
      }

      if (args.action === 'resolve') {
        if (!args.cwd) return errorResult('cwd is required for resolve action')
        const project = resolveProjectService(args.cwd)
        if (!project) return errorResult(`No project found for path: ${args.cwd}`)
        return jsonResult({ id: project.id, name: project.name, local_path: project.local_path })
      }

      return errorResult(`Unknown action: ${args.action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_manage failed')
    }
  })
}
