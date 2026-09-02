import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const GUIDE_TEXT = `# SynaptoMind — Thought Graph Engine

## Quick Reference

| Concept | Primary Tools |
|---|---|
| Capture | \`create_thought\` (content, tags, status) |
| Find | \`search_thoughts\` (hybrid/vector/BM25), \`get_context\`, \`get_chain\` |
| Connect | \`link_thoughts\` (7 edge types) |
| Group | \`cluster\`, \`auto_cluster\` |
| Schedule | \`create_smart_note\` (5 surface conditions) |
| Prioritize | \`get_frontier\` (importance + readiness + dependencies) |
| Compress | \`crystallize\` (runbook/decision-log/overview) |
| Maintain | \`health_check\` (audit + auto-fix) |
| Reflect | \`reflect_session\` (summary, goals, decisions, pending) |

## Workflow

1. **Search** before creating — use \`search_thoughts\` or \`get_context\` to check existing knowledge
2. **Create** with right status — draft (WIP), active (live), archived (hidden)
3. **Link** related thoughts — every edge boosts importance by 0.1
4. **Schedule** review — attach smart notes to thoughts that should surface later
5. **Cluster** related work — groups are excluded from frontier, keeping it focused
6. **Prioritize** — use \`get_frontier\` to find what to do next
7. **Reflect** at natural breakpoints — call \`reflect_session\` after decisions, tasks, or architectural work

## Thoughts

Fields: content (≤500 soft, ≤600 hard), tags[], status, project_id, is_cluster, is_profile, source.

**Status lifecycle:**
- \`draft\` — work in progress, excluded from frontier candidates
- \`active\` — live, searchable, included in frontier
- \`archived\` — hidden from search and frontier, kept for history

Rules: default status is draft. Profile thoughts (\`is_profile=1\`) cannot be archived. Archived thoughts permanently deleted on second \`archive_thought\` call.

**System tags:**
- \`@profile\`, \`@profile-*\` — persona markers, feed the persona slot
- \`decision\`, \`pending\` — created by session reflection
- \`todo\`, \`directive\` — frontier candidates
- \`gotcha\` — surfaces in crystal "Gotchas" section
- \`cluster\` — auto-added to cluster thoughts
- \`crystal\` — applied to crystal output

## Edges

| Type | When to use |
|---|---|
| \`related\` | General association. Default. Idempotent (duplicates reused) |
| \`parent\` | Hierarchical decomposition. Source = parent, target = child |
| \`develops\` | Conceptual evolution. Source evolves into target |
| \`replaces\` | Source supersedes target. Target blocked in frontier |
| \`cluster\` | Cluster → member. Only from cluster thoughts (\`is_cluster=1\`) |
| \`references\` | Cluster ↔ cluster. Mutual link between clusters |
| \`depends_on\` | Source blocked until target done. Affects frontier ranking |

Constraints: no self-loops. One edge type per (source, target) pair. Cluster edges enforced strictly.

## Smart Notes

Attach to a thought to make it surface when conditions are met. Promotion sets thought to active, deletes the note (one-shot).

| Condition | Params | Surfaces when... |
|---|---|---|
| \`older_than_days\` | \`days\` | Thought is N+ days old |
| \`has_tag\` | \`tag\` | Thought gains the specified tag |
| \`has_edge_type\` | \`edge_type\` | Thought gets an edge of that type |
| \`project_status\` | \`days\` | Any non-archived thought in same project updated within N days |
| \`unread_for_days\` | \`days\` | Thought unread for N+ days |

Config: \`smartNotes.autoPromote\` (default false) enables dreamer job. \`smartNotes.evalIntervalMs\` (default 1h) sets check frequency.

## Search

Three modes:
- **hybrid** (default) — vector + BM25 via Reciprocal Rank Fusion (k=60). Best general-purpose mode.
- **vector** — semantic similarity only via sqlite-vec. Good for conceptual queries.
- **BM25** — keyword matching via FTS5. Good for exact terms.

Filters: status, project, tag, cluster (only/exclude), min importance, exclude flagged.

Post-processing: hit counting → primer promotion → primer hoisting → profile hoisting.

## Lifecycle

**Importance:** starts at 1.0. Boosted by edges (+0.1) and primer promotion (+0.15). Decays by \`decay.rate\` (default 0.95) every \`decay.intervalMs\` (default 24h).

**Auto-archive:** when importance < \`decay.archiveThreshold\` (0.1) AND age > \`decay.archiveMinAgeDays\` (30) AND status=active AND not a profile thought.

## Projects vs Clusters

| | Projects | Clusters |
|---|---|---|
| Purpose | Organizational containers | Semantic groupings |
| Cardinality | One project per thought | One cluster per thought (enforced) |
| Deletion | Thoughts moved to Default | N/A |
| Git link | Optional auto-sync | N/A |
| Frontier | Included | Excluded |

## Background Jobs

| Job | What it does | Key config |
|---|---|---|
| **dreamer** | Evaluates smart notes, promotes ready ones | \`smartNotes.autoPromote\`, \`evalIntervalMs\` |
| **decay** | Decays importance, auto-archives stale thoughts | \`rate\`, \`archiveThreshold\`, \`archiveMinAgeDays\` |
| **auto-cluster** | Groups similar thoughts into clusters (Union-Find) | \`minAgeDays\`, \`minSimilarity\`, \`minMembers\` |
| **auto-link** | Creates related edges for low-connectivity thoughts | \`minSimilarity\`, \`maxEdgesPerRun\` |
| **self-improve** | Detects issues, auto-corrects (orphan writes, stale drafts) | \`enabled\` (default false) |
| **git-sync** | Pulls git commits into search index | Per-project \`git_sync_interval_ms\` |

## Health Check

Run \`health_check\` to audit graph integrity. Pass \`fix: true\` for auto-repair.

Categories: structural integrity (orphan/self-loop edges), cluster health (empty/singleton), connectivity (islands), content quality (duplicates, stale drafts), semantic consistency (circular chains), data drift (missing embeddings).

Score: 100 - (critical×10) - (warning×3) - (info×0.5), clamped [0,100].

## Crystals

Compress thought chains/clusters into markdown. Styles:

- \`runbook\` — Procedure + Gotchas + Open questions. For operational knowledge.
- \`decision-log\` — Decisions + Gotchas + Open questions. For architectural choices.
- \`overview\` — Context + Gotchas + Open questions. For general background.

Bucketing: draft → "Open questions", tag \`gotcha\` → "Gotchas", rest → main section.

## Session Reflection

Call \`reflect_session\` at natural breakpoints (after a decision, a task, or architectural work).
Records outcomes into slots and creates thoughts:
- \`summary\` — appends to project_context slot
- \`goals_delta\` — add/remove from active_goals (prefix "closed:" to remove)
- \`decisions\` — creates active thoughts with tag \`decision\`
- \`pending\` — creates draft thoughts with tag \`pending\` + smart note (auto-surface after \`wake_days\`, default 7)

## Profile

Mark thoughts with \`is_profile=1\` and \`@profile\` tag. Sub-tags \`@profile-work\`, \`@profile-preferences\` group by topic. Profile thoughts are never auto-archived. Use \`get_profile\` to retrieve persona stats.`

export function registerGuideTools(server: McpServer) {
  server.tool('guide_thoughts', 'Get started with the thought system', {}, async () => {
    return { content: [{ type: 'text' as const, text: GUIDE_TEXT }] }
  })
}
