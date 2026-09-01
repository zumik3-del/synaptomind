import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config'
import { searchThoughts, searchThoughtsGrouped } from '../../services/search.service'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { getThoughtById, createThoughtWithUrlLinks, updateThoughtById, archiveThoughtById, deleteThoughtById, listThoughtsService } from '../../services/thoughts.service'
import { jsonResult, errorResult } from './utils'

export function registerThoughtTools(server: McpServer) {
  server.tool('search_thoughts', 'Semantic search across thoughts', {
    query: z.string().describe('Search query'),
    top_k: z.number().optional().describe('Max results (default 10)'),
    status: z.string().optional().describe('Filter by status'),
    project_id: z.string().optional().describe('Filter by project'),
    tag: z.string().optional().describe('Filter by tag'),
    cluster: z.enum(['only', 'exclude']).optional().describe('Cluster filter: only (clusters only), exclude (exclude clusters)'),
    group_by_cluster: z.boolean().optional().describe('Group results by cluster'),
    min_importance: z.number().optional().describe('Minimum importance'),
    exclude_flagged: z.boolean().optional().describe('Exclude flagged thoughts'),
    hybrid: z.boolean().optional().describe('Use hybrid search')
  }, async (args) => {
    const topK = args.top_k ?? 10
    const searchOpts = {
      query: args.query,
      topK,
      statusFilter: args.status,
      projectFilter: args.project_id,
      tagFilter: args.tag,
      clusterFilter: args.cluster,
      minImportance: args.min_importance,
      excludeFlagged: args.exclude_flagged,
      hybrid: args.hybrid
    }
    const results = args.group_by_cluster
      ? await searchThoughtsGrouped(searchOpts)
      : await searchThoughts(searchOpts)
    const processed = postProcessSearchResults(results, { query: args.query, topK, showPrimers: true })
    return jsonResult(processed)
  })

  server.tool('get_thought', 'Get a single thought by ID', {
    thought_id: z.string().describe('Thought ID')
  }, async (args) => {
    const thought = getThoughtById(args.thought_id)
    if (!thought) return errorResult(`Thought '${args.thought_id}' not found`)
    return jsonResult(thought)
  })

  server.tool('get_thought_timeline', 'List thoughts with pagination', {
    status: z.string().optional().describe('Filter by status'),
    project_id: z.string().optional().describe('Filter by project'),
    limit: z.number().optional().describe('Max results (default 50)'),
    offset: z.number().optional().describe('Offset for pagination')
  }, async (args) => {
    const thoughts = listThoughtsService({
      status: args.status as any,
      project_id: args.project_id,
      limit: args.limit,
      offset: args.offset
    })
    return jsonResult(thoughts)
  })

  server.tool('create_thought', 'Create a new thought', {
    content: z.string().describe(`Thought content (soft limit: ${config.thoughts.softLimit}, hard limit: ${config.thoughts.hardLimit} chars)`),
    tags: z.array(z.string()).optional().describe('Tags'),
    status: z.string().optional().describe('Status (draft/active/archived)'),
    project_id: z.string().optional().describe('Project ID'),
    parent_id: z.string().optional().describe('Parent thought ID'),
    is_profile: z.boolean().optional().describe('Mark as profile thought'),
    url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links')
  }, async (args) => {
    const thought = createThoughtWithUrlLinks(
      { content: args.content, tags: args.tags, status: args.status as any, project_id: args.project_id, is_profile: args.is_profile },
      { parentId: args.parent_id, urlLinks: args.url_links }
    )
    return jsonResult(thought)
  })

  server.tool('update_thought', 'Partially update a thought', {
    thought_id: z.string().describe('Thought ID'),
    content: z.string().optional().describe('New content'),
    tags: z.array(z.string()).optional().describe('New tags'),
    status: z.string().optional().describe('New status'),
    project_id: z.string().optional().describe('New project ID'),
    is_profile: z.boolean().optional().describe('Profile flag')
  }, async (args) => {
    const updated = updateThoughtById(args.thought_id, {
      content: args.content, tags: args.tags, status: args.status as any, project_id: args.project_id, is_profile: args.is_profile
    })
    if (!updated) return errorResult(`Thought '${args.thought_id}' not found`)
    return jsonResult(updated)
  })

  server.tool('assign_thought_to_project', 'Move a thought to a project', {
    thought_id: z.string().describe('Thought ID'),
    project_id: z.string().describe('Project ID')
  }, async (args) => {
    const updated = updateThoughtById(args.thought_id, { project_id: args.project_id })
    if (!updated) return errorResult(`Thought '${args.thought_id}' not found`)
    return jsonResult(updated)
  })

  server.tool('archive_thought', 'Archive or permanently delete a thought', {
    thought_id: z.string().describe('Thought ID')
  }, async (args) => {
    const existing = getThoughtById(args.thought_id)
    if (!existing) return errorResult(`Thought '${args.thought_id}' not found`)
    if (existing.status === 'archived') {
      const deleted = deleteThoughtById(args.thought_id)
      return jsonResult(deleted ? 'Permanently deleted' : 'Delete failed')
    }
    const archived = archiveThoughtById(args.thought_id)
    return jsonResult(archived)
  })
}
