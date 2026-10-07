import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import type { ThoughtStatus } from '../../types/thought'
import {
  createThoughtWithUrlLinks,
  updateThoughtById
} from '../../services/thoughts.service'
import { createEdgeService, deleteEdgeService, findEdgeService, retypeEdgeService, validateRetypeService, EDGE_TYPES } from '../../services/edges.service'
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

  unlink: {
    input: z.object({
      edge_id: requiredString('edge_id is required for unlink action')
    }),
    run(args: ActionArgs) {
      const edgeId = args.edge_id as string
      const confirm = args.confirm === true

      if (!confirm) {
        const edge = findEdgeService(edgeId)
        if (!edge) return { status: 'not_found', edge_id: edgeId }
        return {
          status: 'preview',
          edge_id: edgeId,
          edge: { id: edge.id, source_id: edge.source_id, target_id: edge.target_id, type: edge.type, created_at: edge.created_at },
          consequence: `Removes the '${edge.type}' edge between '${edge.source_id}' and '${edge.target_id}'.`,
          instruction: `Call memory_store again with action=unlink, edge_id=${edgeId}, confirm=true to proceed.`
        }
      }

      const deleted = deleteEdgeService(edgeId)
      return { status: deleted ? 'deleted' : 'not_found', edge_id: edgeId }
    }
  },

  retype: {
    input: z.object({
      edge_id: requiredString('edge_id is required for retype action'),
      new_type: z.enum(EDGE_TYPES)
    }),
    run(args: ActionArgs) {
      const edgeId = args.edge_id as string
      const newType = args.new_type as string
      const confirm = args.confirm === true

      // Dry-run and confirm run the SAME validation (ADR §2): the preview
      // must never promise a confirm would reject.
      const edge = validateRetypeService(edgeId, newType)

      if (!confirm) {
        return {
          status: 'preview',
          edge_id: edgeId,
          old_type: edge.type,
          new_type: newType,
          source_id: edge.source_id,
          target_id: edge.target_id,
          consequence: `Changes edge type from '${edge.type}' to '${newType}'.`
        }
      }

      const oldType = edge.type
      const retyped = retypeEdgeService(edgeId, newType)
      // retypeEdge does delete+insert, so the id changes — return the fresh
      // id so a chained unlink/retype resolves.
      return { status: 'retyped', edge_id: retyped.id, old_type: oldType, new_type: newType }
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
- unlink: Delete an edge (dry-run with confirm=false, then confirm=true)
- retype: Change an edge's type (dry-run with confirm=false, then confirm=true)`,
    inputSchema: {
      action: z.enum(['create', 'update', 'link', 'unlink', 'retype']).describe('The specific action to perform. This dictates which other parameters are required.'),
      content: z.string().optional().describe(`REQUIRED for "create". OPTIONAL for "update". Ignored for "link", "unlink", "retype". Recommended soft limit: ${getAdvertisedSoftLimitService()} chars.`),
      tags: z.array(z.string()).optional().describe('Tags'),
      status: z.enum(['draft', 'active', 'archived']).optional().describe('Status (draft/active/archived)'),
      project_id: z.string().optional().describe('Project ID (prefer cwd instead)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      parent_id: z.string().optional().describe('Parent thought ID (for create)'),
      is_profile: z.boolean().optional().describe('Mark as profile thought'),
      is_protected: z.boolean().optional().describe('Protect from auto-deletion'),
      url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links (for create)'),
      thought_id: z.string().optional().describe('REQUIRED for "update", "link". IGNORED for "create", "unlink", "retype".'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "link". IGNORED for all other actions.'),
      edge_type: z.enum(EDGE_TYPES).optional().describe('Edge type (default: related)'),
      edge_id: z.string().optional().describe('REQUIRED for "unlink" and "retype". The edge to modify.'),
      new_type: z.enum(EDGE_TYPES).optional().describe('REQUIRED for "retype". The new edge type.'),
      confirm: z.boolean().optional().describe('unlink/retype: set true to execute the write; absent/false is a non-mutating dry-run')
    },
    handlers
  })
}
