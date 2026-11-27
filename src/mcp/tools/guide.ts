import type { McpServer } from '@modelcontextprotocol/server'
import { type Config, config } from '../../config'
import { getThoughtLimitsDB } from '../../config.thought-limits'
import { READ_ONLY } from './action-tool'
import { toolOutputShape } from './utils'

function buildGuideText(softLimit: number): string {
  return `# SynaptoMind — Reference

Full action reference: docs/mcp-tools.md. HTTP ops endpoints (health, health-check, repair): docs/API.md.

## Tools
| Tool | Actions |
|---|---|
| memory_recall | search, get, context, chain, list |
| memory_store | create, update, link, link_batch, unlink, unlink_batch, retype, bulk_create |
| memory_supersede | archive, archive_batch, merge |
| memory_status | slots, frontier, config, health |
| memory_projects | list, create, update, delete |
| memory_crystallize | graph, cluster, auto_cluster |
| memory_reflect | reflect |
| memory_primers | list, delete |
| memory_retention | list, delete, compact |
| memory_guide | (no action) |

## Response envelope
A collection answers {items, meta}, a single object {item, meta} (item null when nothing was found); memory_crystallize graph is the exception, with nodes as items and edges beside them.
meta: action, scope, counts, degraded, warnings, plus reason (no_match, id_not_found, ambiguous_id) and preview. scope is {project, project_name, global} or null; counts always carries total, returned and filtered_out beside the action counters.
A failure is not an envelope: isError: true with {error: {message, statusCode?, retryable?}} and the same message in content[].text — the shape of every action-layer refusal, retryable true only for 503.

## Working directory (cwd)
cwd is optional everywhere; it scopes memory_recall search/list/context, memory_status slots/frontier, memory_reflect reflect and memory_crystallize graph/cluster. A reader with no resolved project answers across every project (scope null plus a warning, global: true for an unknown path); slots also warns that the project-scoped overrides went unapplied. A write never widens or warns: a create lands in the project the path names, else the default project; an id-addressed write keeps its row's project; an unknown path leaves only {project: null, global: true}. reflect is a write here.

## Destructive operations (preview by default)
memory_store unlink/retype/unlink_batch, memory_supersede archive/archive_batch/merge, memory_projects delete, memory_primers delete, memory_crystallize auto_cluster and memory_retention delete/compact preview first; confirm:true executes and revalidates state, so a preview can go stale. meta.preview carries {token, destructive: true, consequence?, instruction?} with a ~5 min TTL, and confirm:true must send it back as preview_token.
Nothing to fingerprint means token null: unlink_batch, memory_retention compact and an archive/merge preview of a thought that does not exist — confirming one takes no token, but a missing archive/merge target still fails with an error. merge previews eligibility, effects and at most 50 source edges.

## Thoughts
Fields: content (≤${softLimit} soft), tags[], status, project, is_cluster, is_global, is_protected, surface_after, source, url_links.
Status: draft (wip), active (live), archived (hidden); create defaults to draft, status=active publishes. Archiving is explicit (memory_supersede archive; update rejects archived) and idempotent.
Tags: update merges by default, tags_mode=replace overwrites; common ones are decision, pending, todo, directive, gotcha, cluster, reflect.

## Edges
related (default, idempotent), parent, develops, replaces, contradicts (symmetric), supports (directed), cluster, references, depends_on.
No self-loops; one edge per pair; a cluster edge runs from the cluster thought to a non-cluster member only; a replaces target leaves the frontier. link takes source_id + target_id (thought_id is retired).
unlink deletes one edge and never cascades. merge archives the source onto the target, transfers its edges, records a replaces edge and reports edges_transferred; a self-loop, a duplicate non-symmetric edge and a cluster-rejected edge are dropped uncounted.
link_batch creates up to 1000 edges and unlink_batch deletes up to 1000, each in one transaction; both validate every id before writing and answer one row per occurrence with linked/deleted/failed in meta.counts. bulk_create writes up to 10000 thoughts in one transaction, a savepoint per item, so a bad item rolls back only itself and answers its own error row at its index.

## Search
Modes: hybrid (default, RRF fusion of vector + BM25) and vector (hybrid=false); no standalone BM25. Filters: status (default active), cwd, tag, is_cluster, min_importance. limit sets the result count, max_degree bounds chain/context traversal; retired top_k, cluster and mode fail with hints to limit, is_cluster and hybrid.
list pages without a query on status (draft/active/archived/all, default all), cwd, tag, is_cluster, limit (1-500, default 50) and offset, created_at desc; meta.counts carries the un-paged total.
id lookup: a full UUID or a hex prefix of at least 13 characters resolves ids directly, bypassing both search legs; a UUID ignores status, cwd, tag and min_importance, while a prefix takes the call's scope and falls back to the ordinary search on a miss. An id hit is never gated or suppressed (suppress degrades to flag). An ambiguous prefix answers every row as meta.reason ambiguous_id (not an error); a miss adds an id_not_found warning. get's include_edges (default false) inlines upstream/downstream edges.
url_links is opt-in (include_url_links true) on search/list/get/context/chain, attaching [{text, url, label}] to every thought in the answer; compact never hides it and fields never trims it. create sets the list, update replaces it in array order (omitted keeps it, [] clears it), and a content edit never touches a link.
min_relevance gates cosine-only hits on the calibrated 0-1 scale (0.8 → 0, 0.9 → 1): omitted applies 0.4, 0 disables the gate, BM25 and id rows are never gated, gated rows land in meta.counts.filtered_out, and context keeps its best match.
recency_weight (default 0) with recency_half_life_days (default 30) adds recency and final scores above 0; supersession_mode (off/flag/suppress, default suppress) and contradiction_mode (off/flag, default flag) set how superseded and contradicted rows are annotated.

## Lifecycle and scheduled jobs
Importance decays by decay.rate (default 0.95) per decay.intervalMs (default 24 h) and decay never archives; archiving is explicit, and only memory_retention delete hard-deletes. decay and preview-token-retention run only in the process that owns background jobs; auto_cluster is on demand, never scheduled.

## Projects, clusters and primers
One project per thought; a cluster is an is_cluster=1 thought whose cluster edges point at its members, and clusters never enter the frontier. crystallize graph pages nodes by cwd, offset (default 0) and limit (default 500, max 2000); cluster turns thought_ids into a cluster thought plus cluster edges; auto_cluster previews unless confirm:true.
A recalled thought whose hit count reaches primer.promoteThreshold (default 5) becomes a primer on the search path; memory_primers list returns them most-hit first, and delete is preview-first (confirm=true) and keeps the thought.

## Health check
memory_status action=health reports findings by severity (read-only; repair is POST /api/health-check/repair with preview then confirm). Score: 100 - criticalCategories×40 - warningCategories×15 - scoredInfoOccurrences×0.25, clamped [0,100], with critical, warning and info beside score_breakdown.
contradiction_in_cluster remediation: unlink the contradicts edge, retype it to supports/related, or archive the cluster thought — dry-run then confirm=true.

## Session reflection
reflect writes: decisions create active thoughts tagged decision + reflect, pending create draft ones tagged pending + reflect, surfaced after wake_days (default 7). summary appends to project_context, and goals_add/goals_remove edit goals by case-insensitive substring (goals_delta is retired). slots: only project_context/active_goals are stored rows; pending_items derives from thoughts tagged pending, architecture_decisions from primers, so editing them means editing a thought.`
}

export function registerMemoryGuide(server: McpServer, cfg: Config = config) {
  server.registerTool(
    'memory_guide',
    {
      description: `Read the built-in reference instead of guessing an action, a parameter or a response shape. Read-only and parameterless: one text document, no writes. Call it first in a session, or whenever a name, an argument or an envelope field is uncertain — one call is cheaper than a rejected one. It covers every tool's actions, the shared envelopes and error shape, cwd scoping, preview/confirm, thought fields and statuses, edge types, search modes and filters, retention and decay, health-check scoring and reflection semantics. For current state use memory_status action=config or action=health, memory_recall and memory_primers.`,
      annotations: READ_ONLY,
      outputSchema: toolOutputShape
    },
    async () => {
      const softLimit = getThoughtLimitsDB(cfg).softLimit
      const text = buildGuideText(softLimit)
      return { content: [{ type: 'text' as const, text }], structuredContent: { result: { text } } }
    }
  )
}
