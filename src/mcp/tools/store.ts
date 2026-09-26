import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import type { ThoughtStatus } from '../../types/thought'
import {
  createThoughtWithUrlLinks,
  updateThoughtById
} from '../../services/thoughts.service'
import { createEdgeService } from '../../services/edges.service'
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
  }
}

export function registerMemoryStore(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_store',
    description: `Store and modify thoughts. Actions:
- create: Create a new thought
- update: Partially update a thought (content, tags, status, project)
- link: Create a directed edge between two thoughts`,
    inputSchema: {
      action: z.enum(['create', 'update', 'link']).describe('The specific action to perform. This dictates which other parameters are required.'),
      content: z.string().optional().describe(`REQUIRED for "create". OPTIONAL for "update". Ignored for "link". Recommended soft limit: ${getAdvertisedSoftLimitService()} chars.`),
      tags: z.array(z.string()).optional().describe('Tags'),
      status: z.enum(['draft', 'active', 'archived']).optional().describe('Status (draft/active/archived)'),
      project_id: z.string().optional().describe('Project ID (prefer cwd instead)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      parent_id: z.string().optional().describe('Parent thought ID (for create)'),
      is_profile: z.boolean().optional().describe('Mark as profile thought'),
      is_protected: z.boolean().optional().describe('Protect from auto-deletion'),
      url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links (for create)'),
      thought_id: z.string().optional().describe('REQUIRED for "update", "link". IGNORED for "create".'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "link". IGNORED for all other actions.'),
      edge_type: z.enum(['related', 'parent', 'develops', 'replaces', 'cluster', 'references', 'depends_on', 'contradicts', 'supports']).optional().describe('Edge type (default: related)')
    },
    handlers
  })
}
