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

export function registerProjectTools(server: McpServer) {
  server.tool('list_projects', 'List all projects', {}, async () => {
    const projects = listProjectsService()
    return jsonResult(projects)
  })

  server.tool('create_project', 'Create a new project', {
    name: z.string().describe('Project name'),
    description: z.string().optional().describe('Project description'),
    local_path: z.string().optional().describe('Local filesystem path for auto-resolution from cwd')
  }, async (args) => {
    const project = createProjectService({ name: args.name, description: args.description, local_path: args.local_path })
    return jsonResult(project)
  })

  server.tool('update_project', 'Update a project', {
    project_id: z.string().describe('Project ID'),
    name: z.string().optional().describe('New name'),
    description: z.string().optional().describe('New description'),
    git_repo_url: z.string().optional().describe('Git repo URL (HTTPS or SSH)'),
    local_path: z.string().optional().describe('Local filesystem path for auto-resolution from cwd')
  }, async (args) => {
    updateProjectService(args.project_id, {
      name: args.name,
      description: args.description,
      git_repo_url: args.git_repo_url,
      local_path: args.local_path
    })
    return jsonResult({ success: true, project_id: args.project_id })
  })

  server.tool('delete_project', 'Delete a project. First call with confirm=false to preview what will happen (thought count, where they will be moved). Then call with confirm=true to proceed. Thoughts are reassigned to the Default project before deletion — no thoughts are lost.', {
    project_id: z.string().describe('Project ID to delete'),
    confirm: z.boolean().describe('Set to true to actually delete. Set to false to preview first.')
  }, async (args) => {
    const project = getProjectService(args.project_id)
    if (!project) {
      return errorResult(`Project not found: ${args.project_id}`)
    }

    if (project.name === 'Default') {
      return errorResult('Cannot delete the Default project.')
    }

    if (!args.confirm) {
      const preview = {
        action: 'preview',
        project: { id: project.id, name: project.name, description: project.description },
        thought_count: project.thought_count,
        consequence: project.thought_count > 0
          ? `${project.thought_count} thought(s) will be moved to the Default project before deletion.`
          : 'Project has no thoughts — safe to delete.',
        instruction: 'Call delete_project again with confirm=true to proceed.'
      }
      return jsonResult(preview)
    }

    const deleted = deleteProjectService(args.project_id)
    if (!deleted) {
      return errorResult(`Failed to delete project: ${args.project_id}`)
    }

    const result = {
      action: 'deleted',
      project: { id: project.id, name: project.name },
      thoughts_moved: project.thought_count,
      moved_to: project.thought_count > 0 ? 'Default project' : undefined
    }
    return jsonResult(result)
  })

  server.tool('resolve_project', 'Resolve project from a filesystem path (matches local_path or git remote URL)', {
    cwd: z.string().describe('Working directory path to resolve project from')
  }, async (args) => {
    try {
      const project = resolveProjectService(args.cwd)
      if (!project) {
        return errorResult(`No project found for path: ${args.cwd}`)
      }
      return jsonResult({ id: project.id, name: project.name, local_path: project.local_path })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to resolve project')
    }
  })
}
