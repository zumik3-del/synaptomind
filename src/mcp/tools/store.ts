import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import type { ThoughtStatus } from '../../types/thought'
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
  deleteSmartNote,
  type SurfaceCondition
} from '../../services/smart_notes.service'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  create: {
    input: z.object({ content: requiredString('content is required for create action') }),
    run(args: ActionArgs) {
      return createThoughtWithUrlLinks(
        { content: args.content as string, tags: args.tags as string[] | undefined, status: args.status as ThoughtStatus | undefined, source: 'mcp', project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_profile: args.is_profile as boolean | undefined, is_protected: args.is_protected as boolean | undefined },
        { parentId: args.parent_id as string | undefined, urlLinks: args.url_links as { text: string; url: string }[] | undefined }
      )
    }
  },

  update: {
    input: z.object({ thought_id: requiredString('thought_id is required for update action') }),
    run(args: ActionArgs) {
      const updated = updateThoughtById(args.thought_id as string, {
        content: args.content as string | undefined, tags: args.tags as string[] | undefined, status: args.status as ThoughtStatus | undefined, project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_profile: args.is_profile as boolean | undefined, is_protected: args.is_protected as boolean | undefined
      })
      if (!updated) throw new Error(`Thought '${args.thought_id}' not found`)
      return updated
    }
  },

  link: {
    input: z.object({
      thought_id: requiredString('thought_id is required for link action (source)'),
      target_id: requiredString('target_id is required for link action')
    }),
    run(args: ActionArgs) {
      return createEdgeService(args.thought_id as string, args.target_id as string, args.edge_type as string | undefined)
    }
  },

  smart_note_create: {
    input: z.object({
      thought_id: requiredString('thought_id is required for smart_note_create action'),
      surface_condition: z.unknown().refine(v => v !== undefined, 'surface_condition is required for smart_note_create action')
    }),
    run(args: ActionArgs) {
      return createSmartNoteService(args.thought_id as string, args.surface_condition as SurfaceCondition)
    }
  },

  smart_note_list: {
    run() {
      return listSmartNotesWithReady()
    }
  },

  smart_note_eval: {
    run() {
      return evalAllSmartNotes()
    }
  },

  smart_note_promote: {
    input: z.object({ note_id: requiredString('note_id is required for smart_note_promote action') }),
    run(args: ActionArgs) {
      return promoteSmartNote(args.note_id as string)
    }
  },

  smart_note_delete: {
    input: z.object({ note_id: requiredString('note_id is required for smart_note_delete action') }),
    run(args: ActionArgs) {
      deleteSmartNote(args.note_id as string)
      return { deleted: true }
    }
  }
}

export function registerMemoryStore(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_store',
    description: `Store and modify thoughts. Actions:
- create: Create a new thought
- update: Partially update a thought (content, tags, status, project)
- link: Create a directed edge between two thoughts
- smart_note_create: Create a smart note for a thought with a surface condition
- smart_note_list: List all smart notes with readiness status
- smart_note_eval: Batch evaluate all smart notes
- smart_note_promote: Promote a ready smart note
- smart_note_delete: Delete a smart note`,
    inputSchema: {
      action: z.enum(['create', 'update', 'link', 'smart_note_create', 'smart_note_list', 'smart_note_eval', 'smart_note_promote', 'smart_note_delete']).describe('The specific action to perform. This dictates which other parameters are required.'),
      content: z.string().optional().describe(`REQUIRED for "create". OPTIONAL for "update". STRICTLY IGNORED for "link" and all "smart_note_*" actions. Recommended soft limit: ${getAdvertisedSoftLimitService()} chars.`),
      tags: z.array(z.string()).optional().describe('Tags'),
      status: z.enum(['draft', 'active', 'archived']).optional().describe('Status (draft/active/archived)'),
      project_id: z.string().optional().describe('Project ID (prefer cwd instead)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      parent_id: z.string().optional().describe('Parent thought ID (for create)'),
      is_profile: z.boolean().optional().describe('Mark as profile thought'),
      is_protected: z.boolean().optional().describe('Protect from auto-deletion'),
      url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links (for create)'),
      thought_id: z.string().optional().describe('REQUIRED for "update", "link", "smart_note_create", "smart_note_promote", "smart_note_delete". IGNORED for "create".'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "link". IGNORED for all other actions.'),
      edge_type: z.enum(['related', 'parent', 'develops', 'replaces', 'cluster', 'references', 'depends_on', 'contradicts', 'supports']).optional().describe('Edge type (default: related)'),
      surface_condition: z.record(z.string(), z.unknown()).optional().describe('REQUIRED ONLY for "smart_note_create". Valid condition types: older_than_days, has_tag, has_edge_type, project_status, unread_for_days. IGNORED for all other actions.'),
      note_id: z.string().optional().describe('REQUIRED ONLY for "smart_note_promote" and "smart_note_delete". IGNORED for all other actions.')
    },
    handlers
  })
}
