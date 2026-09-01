import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const GUIDE_TEXT = `# SynaptoMind — Thought Graph Engine

SynaptoMind is a lightweight thought-graph engine for capturing, linking, clustering, and retrieving thoughts.

## Core Concepts

- **Thoughts** — atomic pieces of knowledge with content, tags, status (draft/active/archived)
- **Edges** — directed relationships between thoughts (related, parent, develops, replaces, cluster)
- **Clusters** — groups of related thoughts linked via cluster edges
- **Projects** — organizational containers for thoughts
- **Smart Notes** — dormant thoughts that surface when conditions are met
- **Slots** — deterministic context views (persona, pending_items, architecture_decisions, project_context, active_goals)
- **Frontier** — "what to do next" ranking based on importance, readiness, and dependencies
- **Primers** — frequently accessed thoughts auto-promoted to architecture_decisions slot
- **Crystals** — compressed markdown summaries of thought chains/clusters

## Workflow

1. Search existing thoughts before creating new ones
2. Link related thoughts with appropriate edge types
3. Use clusters to group related thoughts
4. Set smart notes to surface thoughts when conditions are met
5. Use frontier to find what to do next

## Edge Types

- \`related\` — thematic connection without hierarchy
- \`parent\` — broader category → specific instance
- \`develops\` — new thought builds on old one
- \`replaces\` — old thought is outdated
- \`cluster\` — cluster membership`

export function registerGuideTools(server: McpServer) {
  server.tool('guide_thoughts', 'Get started with the thought system', {}, async () => {
    return { content: [{ type: 'text' as const, text: GUIDE_TEXT }] }
  })
}
