import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { toolOutputShape } from './utils'

function buildGuideText(softLimit: number): string {
  return `# SynaptoMind — Reference

## Quick Reference

| Concept | Tool | Action |
|---|---|---|
| Capture | \`memory_store\` | action=create |
| Find | \`memory_recall\` | action=search/get/context/chain/clusters |
| Connect | \`memory_store\` | action=link |
| Group | \`memory_crystallize\` | action=cluster/auto_cluster |
| Plan | \`memory_status\` | action=propose |
| Prioritize | \`memory_status\` | action=frontier |
| Compress | \`memory_crystallize\` | action=crystallize |
| Maintain | \`memory_status\` | action=health |
| Reflect | \`memory_reflect\` | action=reflect |
| Supersede | \`memory_supersede\` | action=archive/merge |
| Projects | \`memory_manage\` | action=list/create/update/delete/resolve |

## Tool Map

| Tool | Actions | Purpose |
|---|---|---|
| \`memory_recall\` | search, get, context, chain, clusters | Find and retrieve thoughts |
| \`memory_store\` | create, update, link | Write and connect thoughts |
| \`memory_supersede\` | archive, merge | Version and supersede thoughts |
| \`memory_status\` | slots, frontier, profile, config, health, edge_suggestions, propose, cleanup | Query system state |
| \`memory_manage\` | list, create, update, delete, resolve | Project management |
| \`memory_crystallize\` | crystallize, graph, cluster, auto_cluster | Consolidate and visualize |
| \`memory_reflect\` | reflect, timeline | Session management |
| \`memory_telemetry\` | query, analyze, primers | Analytics and self-improvement |
| \`memory_guide\` | (no action) | This reference text |

## Thoughts

Fields: content (≤${softLimit} soft), tags[], status, project_id, is_cluster, is_profile, source.

**Status lifecycle:**
- \`draft\` — work in progress; only \`pending\`-tagged drafts surface in the frontier
- \`active\` — live, searchable, included in frontier
- \`archived\` — hidden from search and frontier, kept for history

Rules: default status is draft. Profile thoughts (\`is_profile=1\`) cannot be archived. Archive is idempotent. TTL cleanup deletes after configured retention period.

**System tags:**
- \`@profile\`, \`@profile-*\` — persona markers, feed the persona slot
- \`decision\`, \`pending\` — created by session reflection
- \`todo\`, \`directive\`, \`pending\` — frontier candidates
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
| \`contradicts\` | Two live, mutually exclusive claims. **Symmetric** (A↔B), neither side authoritative — never hide one endpoint |
| \`supports\` | Source provides evidence for target. **Directed** |
| \`cluster\` | Cluster → member. Only from cluster thoughts (\`is_cluster=1\`) |
| \`references\` | Cluster ↔ cluster. Mutual link between clusters |
| \`depends_on\` | Source blocked until target done. Affects frontier ranking |

Constraints: no self-loops. One edge type per (source, target) pair. Cluster edges enforced strictly. Symmetric \`related\`/\`contradicts\` are idempotent in both directions; linking a pair that already has a \`related\` edge with a specific type upgrades the placeholder.

## Search

Three modes:
- **hybrid** (default) — vector + BM25 via Reciprocal Rank Fusion (k=60). Best general-purpose mode.
- **vector** — semantic similarity only via sqlite-vec. Good for conceptual queries.
- **BM25** — keyword matching via FTS5. Good for exact terms.

Filters: status, project, tag, cluster (only/exclude), min importance, exclude flagged.

Result ranking signals: \`match_source\` (legs that matched, in fixed order \`vector\`, \`bm25\`), \`similarity\`/\`distance\` (vector leg only), \`bm25_score\` (keyword relevance, higher = more relevant, only for BM25 hits), and \`rrf_score\` (fused hybrid score, present only when fusion ran).

**Confidence (no-strong-match hint):** every result carries \`low_confidence\` (boolean). \`true\` means there is no strong evidence of relevance — no lexical (\`bm25\`) anchor and no vector hit at or above the configured \`search.confidence.vectorFloor\`. It is an additive hint that never changes ranking, so a \`low_confidence\` result is still returned and readable. To drop weak results server-side, pass \`min_relevance\` (0–1, default **0**): \`> 0\` keeps \`bm25\` hits and vector hits with \`similarity >= min_relevance\` (the candidate pool is widened so \`top_k\` is still filled); \`0\` (unset) returns the full result set unchanged. The two knobs are independent: the floor drives the hint, \`min_relevance\` drives the gate.

**Recency boost (opt-in):** \`recency_weight\` (0–1, default **0**) adds a time term to the ranking; \`recency_half_life_days\` (1–3650, default 30) sets its decay half-life. At \`recency_weight > 0\` each result also carries \`recency_score\` (\`0.5^(ageDays/halfLifeDays)\`, \`1\` = created now) and \`final_score\` (\`relevant + recency_weight × recency_score\`, where \`relevant\` is \`rrf_score\` normalised to \`[0,1]\` on the fused path or \`similarity\` on the vector-only path). \`rrf_score\` stays raw/un-boosted. \`recency_weight = 0\` (unset) preserves the relevance-only ranking and omits both fields.

**Standing (per-axis opt-out):** results carry \`standing\` (\`current\` | \`contradicted\` | \`superseded\`) from the \`supersession_mode\` (\`off\`/\`flag\`/\`suppress\`, agent default \`suppress\`) and \`contradiction_mode\` (\`off\`/\`flag\`, default \`flag\`) axes. \`off\` disables only its own axis' annotation (\`suppress\` also drops superseded rows); contradicted rows are never suppressed. \`standing\` is emitted whenever at least one axis is enabled and omitted entirely only when both are \`off\`. Numeric arguments accept numbers (string-serialized numbers are coerced).

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
| Frontier | Included | Excluded |

## Background Jobs

| Job | What it does | Key config |
|---|---|---|
| **decay** | Decays importance, auto-archives stale thoughts | \`rate\`, \`archiveThreshold\`, \`archiveMinAgeDays\` |
| **auto-cluster** | Groups similar thoughts into clusters (Union-Find) | \`minAgeDays\`, \`minSimilarity\`, \`minMembers\` |
| **auto-link** | Creates related edges for low-connectivity thoughts | \`minSimilarity\`, \`maxEdgesPerRun\` |
| **self-improve** | Detects issues, auto-corrects (orphan writes, stale drafts) | \`enabled\` (default false) |

## Health Check

Run \`memory_status\` (action=health) to audit graph integrity. Pass fix=true for auto-repair.

Categories: structural integrity (orphan/self-loop edges), cluster health (empty/singleton), connectivity (islands), content quality (duplicates, stale drafts), semantic consistency (circular chains, contradiction interactions), data drift (missing embeddings).

Score: 100 - (criticalCategories×40) - (warningCategories×15) - (infoOccurrences×0.25), clamped [0,100]. The score penalises the PRESENCE of a flagged category, not its counts — a large island count dominates via the per-occurrence info term.

Accepted trade-offs on a dense, hub-centric graph (do not "fix" by mutating the graph): \`overlinked_thoughts\` flags curated cross-domain hubs; \`clusterless_dense_thoughts\` is age-gated to the auto-cluster window (task #935). ADR: \`ai-workdir/synaptomind/plans/2026-09-28-928-health-overlinked-clusterless-adr.md\`; recalibration #934.

## Edge Suggestions

Run \`memory_status\` (action=edge_suggestions) to get *candidate* pairs worth reviewing for a link. Detection is a filter, never a source of truth: it is read-only and never writes edges. Confirm a suggestion explicitly with \`memory_store\` (action=link).

Every proposal is similarity-only and always \`type: related\`: high embedding similarity means "same subject matter", **not** "conflict". Each one carries \`review_required: true\` and \`rationale: embedding_similarity_only\` — read both thoughts and decide the real type (\`contradicts\`/\`supports\`/other) yourself; never report or link a proposal as a contradiction on the strength of the proposal alone.

Config: \`edgeDetect.minSimilarity\` (recall threshold), \`topK\`, \`maxCandidates\`, \`maxProposals\`. Embedder unavailability degrades to an empty result (\`degraded: true\`) instead of failing.

## Placement Proposal

Run \`memory_status\` (action=propose) to get one read-only plan for a single thought: pass \`thought_id\` (existing thought) **or** \`content\` (unpersisted draft), plus optional \`project_id\`/\`cwd\`.

The result is a \`PlacementPlan\` — \`placement\` (cluster or parent, or null), \`edges[]\`, \`lifecycle\`, \`degraded\`, \`generated_at\`. Every element carries \`rationale\`, \`confidence\` (ordinal, not calibrated) and \`review_required\`; \`lifecycle.action\` is one of \`keep\`/\`link\`/\`merge\`/\`replaces+archive\`, with \`blocked_by[]\` explaining why a proposed move cannot be confirmed. Pairs that already carry an edge are excluded.

The engine is a filter, never a source of truth: it is read-only and never writes the graph. Confirmation always uses the existing writers — \`memory_store\` (action=link) for edges, \`memory_supersede\` (action=merge/archive) for a merge or supersede, \`memory_crystallize\` (action=cluster) for a placement. There is deliberately **no** \`apply\` action. Embedder unavailability degrades to lexical-only signals (\`degraded: true\`) instead of failing.

Typed edge proposals require a non-embedding cue; embedding similarity alone yields \`related\` with \`rationale: embedding_similarity_only\`. ADR: \`ai-workdir/synaptomind/plans/2026-09-28-placement-link-policy-engine-adr.md\`; see also ADR #142 and task #927. HTTP parity: \`POST /api/thoughts/propose\` (see \`docs/API.md\` §Propose).

## Crystals

Compress thought chains/clusters into markdown. Styles:

- \`runbook\` — Procedure + Gotchas + Open questions. For operational knowledge.
- \`decision-log\` — Decisions + Gotchas + Open questions. For architectural choices.
- \`overview\` — Context + Gotchas + Open questions. For general background.

Bucketing: draft → "Open questions", tag \`gotcha\` → "Gotchas", rest → main section.

## Session Reflection

Call \`memory_reflect\` (action=reflect) at natural breakpoints (after a decision, a task, or architectural work).
Records outcomes into slots and creates thoughts:
- \`summary\` — appends to project_context slot
- \`goals_delta\` — add/remove from active_goals (prefix "closed:" to remove)
- \`decisions\` — creates active thoughts with tag \`decision\`
- \`pending\` — creates draft thoughts with tag \`pending\` (surface in the frontier after \`wake_days\`, default 7)

## Profile

Mark thoughts with \`is_profile=1\` and \`@profile\` tag. Sub-tags \`@profile-work\`, \`@profile-preferences\` group by topic. Profile thoughts are never auto-archived. Use \`memory_status\` (action=profile) to retrieve persona stats.`
}

export function registerMemoryGuide(server: McpServer) {
  server.registerTool('memory_guide', {
    description: 'Reference for tools, parameters, and system behavior',
    outputSchema: toolOutputShape
  }, async () => {
    const softLimit = getAdvertisedSoftLimitService()
    const text = buildGuideText(softLimit)
    return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } }
  })
}
