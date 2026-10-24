import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { toolOutputShape } from './utils'

/**
 * The in-band quick map.
 *
 * Deliberately short: it carries only what an agent needs to pick a tool, and
 * points at `docs/mcp-tools.md` (actions, arguments, dry-run/confirm pattern,
 * envelopes) and `docs/API.md` (HTTP parity) for the rest. Keeping the detail
 * in one place is what stops this text from drifting away from the registered
 * surface, which it did when it still advertised tools and jobs that no longer
 * exist (tasks #1937-#1951).
 *
 * The only value resolved at call time is the advertised content soft limit,
 * read through the same service the tool schemas use (`settings.service`), so
 * the two can never disagree (F13).
 */
function buildGuideText(softLimit: number): string {
  return `# SynaptoMind — Reference

Full action reference: docs/mcp-tools.md. HTTP parity: docs/API.md.

## Tools
| Tool | Actions |
|---|---|
| memory_recall | search, get, context, chain, clusters, list |
| memory_store | create, update, link, link_batch, unlink, unlink_batch, retype |
| memory_supersede | archive, archive_batch, merge |
| memory_status | slots, frontier, config, health, propose |
| memory_manage | list, create, update, delete, resolve |
| edge_review | enqueue, list, apply, apply_batch, rollback, reject |
| memory_crystallize | graph (offset/limit/total), cluster, auto_cluster |
| memory_reflect | reflect, timeline |
| memory_primers | list, delete |
| memory_guide | (no action) |

## Tool responsibilities
- memory_manage = CRUD for projects (list, create, update, delete, resolve) and project resolution from a path (resolve from cwd). It is the only tool that writes project rows.
- memory_status = read-only system state: slots, frontier, config, health, propose (read-only plan). It never writes thoughts or projects.
- memory_store / memory_supersede = thought and edge writes; memory_recall = reads/search.

## Destructive operations (preview by default)
memory_store unlink/retype, memory_supersede archive/archive_batch/merge, memory_manage delete, edge_review apply/apply_batch/rollback, memory_primers delete, and memory_crystallize auto_cluster are preview-first. confirm absent/false previews; confirm:true executes. Execution revalidates current state: previews can become stale, and there is no preview token or reservation. memory_supersede archive previews outcome (including missing, already archived, and protected); archive_batch preview returns ordered per-occurrence items, while confirmed execution returns the aggregate {archived, failed, errors} (errors are ordered), not per-item success records; merge previews eligibility, proposed values/effects, and at most 50 source edges with a count/truncation flag. This is an MCP contract only; HTTP merge remains immediate and unchanged. Retired argument names are rejected with an error hint naming the replacement.
Slots (memory_status action=slots) are read-only: pending_items is derived from thoughts tagged pending, architecture_decisions from primers, and only project_context/active_goals are stored rows. To change slot content, update or archive the underlying thoughts (virtual slots) or use memory_reflect (summary, goals_add, goals_remove) for the explicit slots; memory_status never writes.

## Thoughts
Fields: content (≤${softLimit} soft), tags[], status, project_id, is_cluster, is_global, is_protected, surface_after, source.
Status: draft (wip), active (live), archived (hidden). Default draft on create; pass status=active to publish. Archive is idempotent.
Tags: update merges by default; pass tags_mode=replace to overwrite the whole set. Common tags: decision, pending, todo, directive, gotcha, cluster, reflect.

## Edges
related (default, idempotent), parent, develops, replaces (target blocked in frontier), contradicts (symmetric), supports (directed), cluster, references, depends_on.
No self-loops; one type per pair; cluster edges strict; a retype upgrades a related edge in place.
link takes source_id + target_id; thought_id is a retired alias and errors with a replacement hint. merge takes source_id + target_id.
merge archives the source onto the target; executed calls return {status:"executed", action:"merge", result:{target, edges_transferred}}, where edges_transferred counts source edges the target now holds. Dropped — and not counted — are a self-loop the merge would create, a duplicate non-symmetric edge, and a cluster edge the cluster rule rejects; an existing related/contradicts pair still counts, since the target now owns that relation.
unlink, retype, archive, archive_batch and merge are preview-first: confirm absent/false returns status "preview" and requires confirm:true to execute. No cascade. archive_batch preview returns an ordered items array with one entry per requested occurrence. Confirmed execution processes IDs in input order and returns the aggregate {archived, failed, errors}; errors are ordered, and there is no per-item success-record array. Duplicate IDs are idempotent. Merge preview edge descriptors are bounded (50 max); execution reports {status:"executed", action:"merge", result:{target, edges_transferred}}. Example execution request: {"action":"merge","source_id":"thought-a","target_id":"thought-b","confirm":true}; without confirm:true, this request previews.
link_batch creates up to 1000 edges in one transaction and reports per item as {linked, failed, errors[]}; unlink_batch deletes/previews up to 1000 edges in one transaction, validates all ids exist before deleting any, and reports per edge as {deleted, preview, failed} with counts.

## Search
Modes: hybrid (default true, RRF fusion of vector + BM25), vector (hybrid=false). There is no standalone BM25 mode; BM25 contributes inside hybrid. Filters: status, project, tag, is_cluster, min importance. limit sets search result count; max_degree bounds chain/context traversal, not result count. Retired top_k, cluster, and mode inputs fail with hints to use limit, is_cluster, and hybrid.
memory_recall action=list returns a paginated inventory without a query: filters status (draft/active/archived), project_id, tag, is_cluster (true=clusters only, false=non-clusters); paging limit (1-500, default 50) and offset; result {thoughts[], total, limit, offset} with total the un-paged count. Ordering is fixed (created_at desc); there is no sort parameter. Example: {"action":"list","status":"draft","limit":50,"offset":0}.
memory_recall action=get accepts include_edges (default false) to return incident edges inline (upstream/downstream with type and created_at).
BM25 hits are immediate; vector/hybrid hits appear only after the embedder stores the vector in vec_thoughts (polls pending_embeddings every embedder.pollIntervalMs, default 7000 ms; visible ~10-15 s).
low_confidence: no BM25 anchor, or vector below search.confidence.vectorFloor. min_relevance gates weak vector-only hits (default 0 = all).
match_source: subset of {embedding, bm25} — indicates which legs matched (embedding = vector leg, bm25 = keyword leg); both = hybrid overlap, embedding = semantic only, bm25 = keyword only.
similarity/distance: cosine similarity (and 1-similarity distance) for the embedding leg; omitted (null-ish) for BM25-only matches so a keyword hit is not misread as zero relevance. rrf_score/bm25_score are additive ranking signals.
recency_weight (default 0) + recency_half_life_days (default 30) add recency_score/final_score when >0. supersession_mode (off/flag/suppress, default suppress) + contradiction_mode (off/flag, default flag).

## Lifecycle
Importance decays by decay.rate (default 0.95) per decay.intervalMs (default 24 h). Decay only lowers importance — it never archives.
Archiving is explicit (memory_supersede archive, or status=archived). Deletion of archived thoughts is handled by the retention-review process (the sole deletion path).

## Scheduled jobs
Started in src/index.ts when the process owns background jobs: decay, placement-retention. auto_cluster is on demand (memory_crystallize action=auto_cluster) and never scheduled.

## Projects and clusters
One project per thought. A cluster is a thought with is_cluster=1 whose cluster edges point at its members; cluster thoughts never enter the frontier.
memory_crystallize action=graph paginates nodes: offset (default 0), limit (default 500, max 2000); the response includes total (node count for the filters) alongside nodes/edges. auto_cluster previews unless confirm:true; retired dry_run fails with a hint to use confirm.
## Primers
A recalled thought whose hit count reaches primer.promoteThreshold (default 5) becomes a primer on the search path. memory_primers delete is preview-first (confirm=true); the HTTP DELETE is immediate.

## Health check
memory_status action=health; severity restricts reported findings, fix=true auto-repairs safe issues. Score: 100 - criticalCategories×40 - warningCategories×15 - scoredInfoOccurrences×0.25, clamped [0,100]. Islands are an informational coverage finding and are not scored, so publishing an unlinked thought never lowers the score.
contradiction_in_cluster remediation: memory_store action=unlink on the contradicts edge, or retype it to supports/related, or archive the cluster thought. Dry-run first, then confirm=true.

## Placement proposal and review
memory_status action=propose returns a read-only plan (placement, edges[], lifecycle) and never writes. edge_review enqueue/list/apply/apply_batch/rollback/reject; apply is dry-run unless confirm=true and re-checks staleness. The queue holds edge items only: a plan's placement and lifecycle items are reported as skipped.

## Session reflection
memory_reflect reflect writes thoughts, it is not read-only: decisions create active thoughts tagged decision + reflect; pending create draft thoughts tagged pending + reflect (surface after wake_days, default 7). The reflect tag marks every thought reflect created, so they can be filtered (search tag=reflect) or cleaned up without touching hand-created ones. summary appends to project_context; goals_add adds goals and goals_remove removes stored goal lines using case-insensitive substring matching. Retired goals_delta fails with a hint to use goals_add/goals_remove.`
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
