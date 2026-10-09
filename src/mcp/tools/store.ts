import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { EDGE_TYPES } from '../../services/edges.service'
import { registerActionTool } from './action-tool'
import { createHandler } from './store/create'
import { updateHandler } from './store/update'
import { linkHandler } from './store/link'
import { unlinkHandler } from './store/unlink'
import { retypeHandler } from './store/retype'

const handlers = {
  create: createHandler,
  update: updateHandler,
  link: linkHandler,
  unlink: unlinkHandler,
  retype: retypeHandler
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
      is_global: z.boolean().optional().describe('Mark as global thought (appears in all project-scoped searches)'),
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
