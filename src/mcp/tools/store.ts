import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config'
import {
  createThoughtWithUrlLinks,
  updateThoughtById
} from '../../services/thoughts.service'
import { createEdgeService } from '../../services/edges.service'
import {
  createSmartNoteService,
  listSmartNotesWithReady,
  evalAllSmartNotes,
  promoteSmartNote,
  deleteSmartNote
} from '../../services/smart_notes.service'
import type { SurfaceCondition } from '../../db/smart_notes'
import { jsonResult, errorResult, resolveProjectId } from './utils'

type StoreArgs = Record<string, unknown>

const actionHandlers: Record<string, (args: StoreArgs) => unknown> = {
  create(args) {
    if (!args.content) throw new Error('content is required for create action')
    return createThoughtWithUrlLinks(
      { content: args.content as string, tags: args.tags as string[] | undefined, status: args.status as any, project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_profile: args.is_profile as boolean | undefined, is_protected: args.is_protected as boolean | undefined },
      { parentId: args.parent_id as string | undefined, urlLinks: args.url_links as { text: string; url: string }[] | undefined }
    )
  },

  update(args) {
    if (!args.thought_id) throw new Error('thought_id is required for update action')
    const updated = updateThoughtById(args.thought_id as string, {
      content: args.content as string | undefined, tags: args.tags as string[] | undefined, status: args.status as any, project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_profile: args.is_profile as boolean | undefined, is_protected: args.is_protected as boolean | undefined
    })
    if (!updated) throw new Error(`Thought '${args.thought_id}' not found`)
    return updated
  },

  link(args) {
    if (!args.thought_id) throw new Error('thought_id is required for link action (source)')
    if (!args.target_id) throw new Error('target_id is required for link action')
    return createEdgeService(args.thought_id as string, args.target_id as string, args.edge_type as any)
  },

  smart_note_create(args) {
    if (!args.thought_id) throw new Error('thought_id is required for smart_note_create action')
    if (!args.surface_condition) throw new Error('surface_condition is required for smart_note_create action')
    return createSmartNoteService(args.thought_id as string, args.surface_condition as SurfaceCondition)
  },

  smart_note_list() {
    return listSmartNotesWithReady()
  },

  smart_note_eval() {
    return evalAllSmartNotes()
  },

  smart_note_promote(args) {
    if (!args.note_id) throw new Error('note_id is required for smart_note_promote action')
    return promoteSmartNote(args.note_id as string)
  },

  smart_note_delete(args) {
    if (!args.note_id) throw new Error('note_id is required for smart_note_delete action')
    deleteSmartNote(args.note_id as string)
    return { deleted: true }
  }
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
    is_protected: z.boolean().optional().describe('Protect from auto-deletion'),
    url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links (for create)'),
    thought_id: z.string().optional().describe('REQUIRED for "update", "link", "smart_note_create", "smart_note_promote", "smart_note_delete". IGNORED for "create".'),
    target_id: z.string().optional().describe('REQUIRED ONLY for "link". IGNORED for all other actions.'),
    edge_type: z.enum(['related', 'parent', 'develops', 'replaces', 'cluster', 'references', 'depends_on']).optional().describe('Edge type (default: related)'),
    surface_condition: z.record(z.string(), z.any()).optional().describe('REQUIRED ONLY for "smart_note_create". IGNORED for all other actions.'),
    note_id: z.string().optional().describe('REQUIRED ONLY for "smart_note_promote" and "smart_note_delete". IGNORED for all other actions.')
  }, async (args) => {
    try {
      const handler = actionHandlers[args.action as string]
      if (!handler) return errorResult(`Unknown action: ${args.action}`)
      return jsonResult(handler(args))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_store failed')
    }
  })
}
