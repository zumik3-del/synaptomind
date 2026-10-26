import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { toolOutputShape } from './utils'

/**
 * The in-band quick map.
 *
 * Deliberately short: it carries only what an agent needs to pick a tool, and
 * points at `docs/mcp-tools.md` (actions, arguments, dry-run/confirm pattern,
 * envelopes) and `docs/API.md` (the ops endpoints) for the rest. Keeping the
 * detail in one place is what stops this text from drifting away from the
 * registered surface, which it did when it still advertised tools and jobs that
 * no longer exist (tasks #1937-#1951).
 *
 * The only value resolved at call time is the advertised content soft limit,
 * read through the same service the tool schemas use (`settings.service`), so
 * the two can never disagree (F13).
 */
function buildGuideText(softLimit: number): string {
  return `# SynaptoMind — Reference

Full action reference: docs/mcp-tools.md. HTTP ops endpoints (health, health-check, repair): docs/API.md.

## Tools
| Tool | Actions |
|---|---|
| memory_recall | search, get, context, chain, clusters, list |
| memory_store | create, update, link, link_batch, unlink, unlink_batch, retype, bulk_create |
| memory_supersede | archive, archive_batch, merge |
| memory_status | slots, frontier, config, health, propose |
| memory_manage | list, create, update, delete, resolve |
| edge_review | enqueue, list, apply, apply_batch, rollback, reject |
| memory_crystallize | graph (offset/limit/total), cluster, auto_cluster |
| memory_reflect | reflect, timeline |
| memory_primers | list, delete |
| retention_review | list, protect, delete, compact |
| memory_guide | (no action) |

## Response envelope
Every action answers in one envelope: a collection action returns {items, meta}, a single-object action returns {item, meta} (item null when the action legitimately found nothing). meta always carries action, scope, counts, degraded and warnings, plus reason (no_match, id_not_found, ambiguous_id) and preview where applicable. counts always carries total, returned and filtered_out beside the action-specific counters (linked/failed, archived/failed, members/edges, ...), so a caller never counts items itself. scope is the project cwd resolved to ({project, project_name, global}) or null for an action that is not project-scoped; an unknown cwd answers globally with a warning. The one exception is memory_crystallize action=graph: nodes are items, edges ride beside them as edges.
A preview answer sets meta.preview {token, destructive: true, consequence?, instruction?}; an executed answer carries no preview key. unlink_batch and retention_review compact issue no token (meta.preview.token null).
Write answers follow the same shape: create/update/link/merge/... nest their old top-level payload under item, and batches report per-row items plus meta.counts ([{status, source, target, error?}] etc.). Per-action keys (thoughts, proposals, linked/errors, archived/errors, preview_token at the root) are gone.

## Tool responsibilities
- memory_manage = CRUD for projects (list, create, update, delete, resolve) and project resolution from a path (resolve from cwd). It is the only tool that writes project rows.
- memory_status = read-only system state: slots, frontier, config, health, propose (read-only plan). It never writes thoughts or projects.
- memory_store / memory_supersede = thought and edge writes; memory_recall = reads/search.

## Working directory (cwd)
cwd is REQUIRED for the project-scoped actions: memory_recall search/clusters/list, memory_status slots/frontier/propose, memory_reflect reflect/timeline. A missing or empty cwd fails with a 400 error envelope naming the argument and the memory_manage action=resolve check; it used to widen silently to every project. cwd is OPTIONAL for memory_recall context (it scopes the query path), for the read actions memory_crystallize graph and edge_review list (it scopes the answer; a call without cwd, or with one no project owns, answers across every project and says so in meta.warnings), and for writes (the write lands in the resolved project, or the default project when cwd is absent); get/chain and the global actions (health, config, primers, crystallize auto_cluster) take no cwd. A present-but-unregistered cwd is not an error: scope.global is true and a warning says the answer spans every project. The HTTP listener is an ops plane only (health/health-check/repair): every thought operation above is MCP-only.

## Destructive operations (preview by default)
memory_store unlink/retype/unlink_batch, memory_supersede archive/archive_batch/merge, memory_manage delete, edge_review apply/apply_batch/rollback, memory_primers delete, memory_crystallize auto_cluster and retention_review delete/compact are preview-first. confirm absent/false previews; confirm:true executes. Execution revalidates current state: previews can become stale. A preview sets meta.preview {token, destructive: true, consequence?, instruction?}; the token is stored in the DB with a ~5 min TTL and confirm:true requires it, except for the two tokenless previews (unlink_batch, retention_review compact) where meta.preview.token is null and confirm:true alone executes. memory_supersede archive previews outcome (including missing and already archived); archive_batch preview returns ordered per-occurrence items and confirmed execution returns one row per occurrence ({thought_id, status: archived|failed, error?}) with meta.counts.archived/failed; merge previews eligibility, proposed values/effects, and at most 50 source edges with a count/truncation flag. Retired argument names are rejected with an error hint naming the replacement.
Slots (memory_status action=slots) are read-only: pending_items is derived from thoughts tagged pending, architecture_decisions from primers, and only project_context/active_goals are stored rows. To change slot content, update or archive the underlying thoughts (virtual slots) or use memory_reflect (summary, goals_add, goals_remove) for the explicit slots; memory_status never writes.

## Thoughts
Fields: content (≤${softLimit} soft), tags[], status, project (resolved from cwd), is_cluster, is_global, is_protected, surface_after, source.
Status: draft (wip), active (live), archived (hidden). Default draft on create; pass status=active to publish. Archive is idempotent.
Tags: update merges by default; pass tags_mode=replace to overwrite the whole set. Common tags: decision, pending, todo, directive, gotcha, cluster, reflect.

## Edges
related (default, idempotent), parent, develops, replaces (target blocked in frontier), contradicts (symmetric), supports (directed), cluster, references, depends_on.
No self-loops; one type per pair; cluster edges strict; a retype upgrades a related edge in place.
link takes source_id + target_id; thought_id is a retired alias and errors with a replacement hint. merge takes source_id + target_id.
merge archives the source onto the target; executed calls answer item:{status:"executed", action:"merge", result:{target, edges_transferred}}, where edges_transferred counts source edges the target now holds. Dropped — and not counted — are a self-loop the merge would create, a duplicate non-symmetric edge, and a cluster edge the cluster rule rejects; an existing related/contradicts pair still counts, since the target now owns that relation.
unlink, retype, archive, archive_batch and merge are preview-first: confirm absent/false returns status "preview" inside item plus meta.preview, and requires confirm:true to execute. No cascade. archive_batch preview returns an ordered items array with one entry per requested occurrence. Confirmed execution processes IDs in input order and returns one row per occurrence ({thought_id, status:"archived"|"failed", error?}) with archived/failed in meta.counts; duplicate IDs are idempotent. Merge preview edge descriptors are bounded (50 max); execution reports item:{status:"executed", action:"merge", result:{target, edges_transferred}}. Example execution request: {"action":"merge","source_id":"thought-a","target_id":"thought-b","confirm":true}; without confirm:true, this request previews.
link_batch creates up to 1000 edges in one transaction and reports one item per requested link in input order ({index, status:"linked"|"failed", source, target, type?, error?}) with linked/failed in meta.counts; unlink_batch deletes/previews up to 1000 edges in one transaction, validates all ids exist before deleting any, and reports one item per edge with deleted/preview/failed in meta.counts.

## Search
Modes: hybrid (default true, RRF fusion of vector + BM25), vector (hybrid=false). There is no standalone BM25 mode; BM25 contributes inside hybrid. Filters: status, cwd (required), tag, is_cluster, min importance. limit sets search result count; max_degree bounds chain/context traversal, not result count. Retired top_k, cluster, and mode inputs fail with hints to use limit, is_cluster, and hybrid.
memory_recall action=list returns a paginated inventory without a query: filters status (draft/active/archived/all), cwd (required), tag, is_cluster (true=clusters only, false=non-clusters); paging limit (1-500, default 50) and offset; result {items, meta} where meta.counts.total is the un-paged count, meta.counts.limit and meta.counts.offset the page that actually ran (defaults applied), and filtered_out the rows the page left out. Ordering is fixed (created_at desc); there is no sort parameter. Example: {"action":"list","status":"draft","limit":50,"offset":0,"cwd":"/path/to/project"}.
memory_recall action=get accepts include_edges (default false) to return incident edges inline: upstream/downstream arrays of {edge, thought}; result is {item, meta}, and an unknown thought_id fails with a 404 error envelope.
url_links (the read side of a thought's url links) is opt-in on memory_recall (search/clusters/list/get/context/chain) and memory_reflect action=timeline: include_url_links true attaches [{text, url, label}] to every thought the answer emits — including get's upstream/downstream neighbours and chain/context neighbourhoods — read in one batch query, ordered by sort_order then creation. Default false emits no key at all; true with no links emits []. compact never hides it and fields never trims it (include_url_links:true with fields:['id'] answers {id, url_links}). Writing a url link is create-time only (memory_store action=create url_links); there is no MCP action to add or delete one after the fact.
Id lookup: a query that is a full UUID or a hex prefix of at least 13 characters (case-insensitive, hyphens optional and normalised) bypasses the semantic and lexical legs and resolves thought ids directly; the 13-character floor is the UUIDv7 timestamp window, so a shorter hex-looking word stays an ordinary query. A full UUID is an explicit reference and ignores status, cwd/project, tag and min_importance; a prefix is a timestamp window, so it takes the status/cwd scope of the call (a prefix that addresses nothing inside the scope falls back to the ordinary search). is_cluster is a shape constraint, not a scope, so it applies to both forms: clusters never answers a non-cluster row. Neither form is ever gated. An explicit id is never suppressed either: suppress degrades to flag for the lookup, hits are annotated with their standing and keep match_source ["id"] with low_confidence false (contested state rides in standing/superseded_by), with no relevance. Several prefix matches answer every row by id with meta.reason "ambiguous_id" (not an error), capped at limit rows with a hard ceiling of 100 so one bulk_create batch cannot flood the answer (a truncated answer still reports ambiguous_id). A miss is not an answer: an id-shaped query that addresses no thought answers with the ordinary search for that text plus an id_not_found note in meta.warnings, and meta.reason "id_not_found" only when that fallback matched nothing either.
BM25 hits are immediate; vector/hybrid hits appear only after the embedder stores the vector in vec_thoughts (polls pending_embeddings every embedder.pollIntervalMs, default 7000 ms; visible ~10-15 s).
low_confidence: no BM25 anchor and vector similarity below search.confidence.vectorFloor; an id-addressed hit has no cosine, so its low_confidence is always false (its contested state rides in standing/superseded_by/contradicted_by). relevance is the calibrated 0-1 scale: clamp01((similarity - search.confidence.unrelatedFloor)/(vectorFloor - unrelatedFloor)), so 0.8 → 0 and 0.9 → 1 (measured: unrelated p95 0.8002, max 0.8355). min_relevance gates cosine-only hits on that scale; omitted = the default gate 0.4 (raw 0.84), an explicit 0 disables it and restores the fail-open result set, BM25-anchored and id rows are never gated. Gated rows show up as meta.counts.filtered_out, not as a reason. memory_recall action=context is the exception: it asks for the single best match instead of a ranked list, so it keeps the pre-gate behaviour and never drops its best match to the gate (passing a gate there is a service-level opt-in only).
match_source: subset of {embedding, bm25, id} — which legs matched. It is ranking metadata, so it is emitted only with compact:false; the safety annotations (standing unless "current", superseded_by, contradicted_by, low_confidence:true) are always present, compact or not.
similarity/distance: cosine similarity (and 1-similarity distance) for the embedding leg; omitted (null-ish) for BM25-only matches so a keyword hit is not misread as zero relevance. rrf_score/bm25_score are additive ranking signals. compact:false adds the scores block {similarity, distance, rrf_score, bm25_score, relevance, recency_score, final_score} (only the keys that apply) and the neutral standing:"current"/low_confidence:false markers.
recency_weight (default 0) + recency_half_life_days (default 30) add recency_score/final_score when >0. supersession_mode (off/flag/suppress, default suppress) + contradiction_mode (off/flag, default flag).

## Lifecycle
Importance decays by decay.rate (default 0.95) per decay.intervalMs (default 24 h). Decay only lowers importance — it never archives.
Archiving is explicit (memory_supersede action=archive; memory_store update rejects status=archived). Deletion of archived thoughts is handled by the retention-review process (the sole deletion path).

## Scheduled jobs
Started in src/index.ts when the process owns background jobs: decay, placement-retention. auto_cluster is on demand (memory_crystallize action=auto_cluster) and never scheduled.

## Projects and clusters
One project per thought. A cluster is a thought with is_cluster=1 whose cluster edges point at its members; cluster thoughts never enter the frontier.
memory_crystallize action=graph paginates nodes: cwd scopes the answer (a call without cwd, or with a path no project owns, answers every project and says so in meta.warnings), offset (default 0), limit (default 500, max 2000); items are the nodes, edges rides beside them, and meta.counts.total is the node count for the filters while returned/filtered_out count that page against it (total = returned + filtered_out, counts.edges = the edges returned). auto_cluster previews unless confirm:true (meta.preview); retired dry_run fails with a hint to use confirm.
## Primers
A recalled thought whose hit count reaches primer.promoteThreshold (default 5) becomes a primer on the search path. memory_primers delete is preview-first (confirm=true).

## Health check
memory_status action=health; severity restricts reported findings (read-only; repair via POST /api/health-check/repair with preview+confirm). Score: 100 - criticalCategories×40 - warningCategories×15 - scoredInfoOccurrences×0.25, clamped [0,100]. Islands are an informational coverage finding and are not scored, so publishing an unlinked thought never lowers the score.
contradiction_in_cluster remediation: memory_store action=unlink on the contradicts edge, or retype it to supports/related, or archive the cluster thought. Dry-run first, then confirm=true.

## Placement proposal and review
memory_status action=propose returns a read-only plan (placement, edges[], lifecycle) and never writes. edge_review enqueue/list/apply/apply_batch/rollback/reject; apply is dry-run unless confirm=true and re-checks staleness. The queue holds edge items only: a plan's placement and lifecycle items are reported as skipped.

## Session reflection
memory_reflect reflect writes thoughts, it is not read-only: decisions create active thoughts tagged decision + reflect; pending create draft thoughts tagged pending + reflect (surface after wake_days, default 7). The reflect tag marks every thought reflect created, so they can be filtered (search tag=reflect) or cleaned up without touching hand-created ones. summary appends to project_context; goals_add adds goals and goals_remove removes stored goal lines using case-insensitive substring matching. Retired goals_delta fails with a hint to use goals_add/goals_remove. memory_reflect action=timeline is the paginated thought list (status, cwd, limit, offset, include_url_links) as {items, meta}; meta.counts carries the applied limit and offset beside total, returned and filtered_out.`
}

export function registerMemoryGuide(server: McpServer) {
  server.registerTool('memory_guide', {
    description: 'Reference for tools, parameters, and system behavior',
    outputSchema: toolOutputShape
  }, async () => {
    const softLimit = getAdvertisedSoftLimitService()
    const text = buildGuideText(softLimit)
    return { content: [{ type: 'text' as const, text }], structuredContent: { result: { text } } }
  })
}
