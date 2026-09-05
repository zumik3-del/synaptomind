import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config'
import {
  createThoughtWithUrlLinks,
  updateThoughtById
} from '../../services/thoughts.service'
import { createEdgeService } from '../../services/edges.service'
import { resolveProjectService } from '../../services/projects.service'
import {
  createSmartNoteService,
  listSmartNotesWithReady,
  evalAllSmartNotes,
  promoteSmartNote,
  deleteSmartNote
} from '../../services/smart_notes.service'
import { jsonResult, errorResult } from './utils'

function resolveProjectId(projectId?: string, cwd?: string): string | undefined {
  if (projectId) return projectId
  if (cwd) {
    const project = resolveProjectService(cwd)
    if (project) return project.id
  }
  return undefined
}

export function registerMemoryStore(server: McpServer) {
  server.tool('memory_store', `Store and modify thoughts. Actions:
- create: Create a new thought
- update: Partially update a thought (content, tags, status, project)
- link: Create a directed edge between two thoughts
- smart_note_create: Create a smart note for a thought with a surface condition
- smart_note_list: List all smart notes with readiness status
- smart_note_eval: Batch evaluate all smart notes
- smart_note_promote: Promote a ready smart note
- smart_note_delete: Delete a smart note`, {
    action: z.enum(['create', 'update', 'link', 'smart_note_create', 'smart_note_list', 'smart_note_eval', 'smart_note_promote', 'smart_note_delete']).describe('The specific action to perform. This dictates which other parameters are required.'),
    content: z.string().optional().describe(`REQUIRED for "create". OPTIONAL for "update". STRICTLY IGNORED for "link" and all "smart_note_*" actions. Soft limit: ${config.thoughts.softLimit}, hard limit: ${config.thoughts.hardLimit} chars.`),
    tags: z.array(z.string()).optional().describe('Tags'),
    status: z.string().optional().describe('Status (draft/active/archived)'),
    project_id: z.string().optional().describe('Project ID (prefer cwd instead)'),
    cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
    parent_id: z.string().optional().describe('Parent thought ID (for create)'),
    is_profile: z.boolean().optional().describe('Mark as profile thought'),
    url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links (for create)'),
    thought_id: z.string().optional().describe('REQUIRED for "update", "link", "smart_note_create", "smart_note_promote", "smart_note_delete". IGNORED for "create".'),
    target_id: z.string().optional().describe('REQUIRED ONLY for "link". IGNORED for all other actions.'),
    edge_type: z.enum(['related', 'parent', 'develops', 'replaces', 'cluster', 'references', 'depends_on']).optional().describe('Edge type (default: related)'),
    surface_condition: z.record(z.string(), z.any()).optional().describe('REQUIRED ONLY for "smart_note_create". IGNORED for all other actions.'),
    note_id: z.string().optional().describe('REQUIRED ONLY for "smart_note_promote" and "smart_note_delete". IGNORED for all other actions.')
  }, async (args) => {
    const projectFilter = resolveProjectId(args.project_id, args.cwd)

    try {
      if (args.action === 'create') {
        if (!args.content) return errorResult('content is required for create action')
        const thought = createThoughtWithUrlLinks(
          { content: args.content, tags: args.tags, status: args.status as any, project_id: projectFilter, is_profile: args.is_profile },
          { parentId: args.parent_id, urlLinks: args.url_links }
        )
        return jsonResult(thought)
      }

      if (args.action === 'update') {
        if (!args.thought_id) return errorResult('thought_id is required for update action')
        const updated = updateThoughtById(args.thought_id, {
          content: args.content, tags: args.tags, status: args.status as any, project_id: projectFilter, is_profile: args.is_profile
        })
        if (!updated) return errorResult(`Thought '${args.thought_id}' not found`)
        return jsonResult(updated)
      }

      if (args.action === 'link') {
        if (!args.thought_id) return errorResult('thought_id is required for link action (source)')
        if (!args.target_id) return errorResult('target_id is required for link action')
        const edge = createEdgeService(args.thought_id, args.target_id, args.edge_type)
        return jsonResult(edge)
      }

      if (args.action === 'smart_note_create') {
        if (!args.thought_id) return errorResult('thought_id is required for smart_note_create action')
        if (!args.surface_condition) return errorResult('surface_condition is required for smart_note_create action')
        const note = createSmartNoteService(args.thought_id, args.surface_condition as any)
        return jsonResult(note)
      }

      if (args.action === 'smart_note_list') {
        const notes = listSmartNotesWithReady()
        return jsonResult(notes)
      }

      if (args.action === 'smart_note_eval') {
        const results = evalAllSmartNotes()
        return jsonResult(results)
      }

      if (args.action === 'smart_note_promote') {
        if (!args.note_id) return errorResult('note_id is required for smart_note_promote action')
        const result = promoteSmartNote(args.note_id)
        return jsonResult(result)
      }

      if (args.action === 'smart_note_delete') {
        if (!args.note_id) return errorResult('note_id is required for smart_note_delete action')
        deleteSmartNote(args.note_id)
        return jsonResult({ deleted: true })
      }

      return errorResult(`Unknown action: ${args.action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_store failed')
    }
  })
}
