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
| memory_status | slots, frontier, config, health, propose, cleanup |
| memory_manage | list, create, update, delete, resolve |
| memory_review | enqueue, list, apply, apply_batch, rollback, reject |
| memory_crystallize | graph (offset/limit/total), cluster, auto_cluster |
| memory_reflect | reflect, timeline |
| memory_primers | list, delete |
| memory_guide | (no action) |

## Tool responsibilities
- memory_manage = CRUD for projects (list, create, update, delete, resolve) and project resolution from a path (resolve from cwd). It is the only tool that writes project rows.
- memory_status = read-only system state: slots, frontier, config, health, propose (read-only plan), cleanup (TTL; dry-run default). It never writes thoughts or projects.
- memory_store / memory_supersede = thought and edge writes; memory_recall = reads/search.

## Destructive operations (preview by default)
memory_store unlink/retype, memory_supersede archive/merge, memory_manage delete, memory_review apply/apply_batch/rollback, memory_primers delete, and memory_status cleanup are destructive: with confirm absent or false (or dry_run: true for cleanup) they return a non-mutating status: "preview" with a consequence and an instruction to re-issue with confirm: true; nothing is written. memory_primers delete and the HTTP DELETE /api/primers/:id differ: HTTP is immediate.
Slots (memory_status action=slots) are read-only: pending_items is derived from thoughts tagged pending, architecture_decisions from primers, and only project_context/active_goals are stored rows. To change slot content, update or archive the underlying thoughts (virtual slots) or use memory_reflect (summary, goals_delta) for the explicit slots; memory_status never writes.

## Thoughts
Fields: content (≤${softLimit} soft), tags[], status, project_id, is_cluster, is_global, is_protected, source.
Status: draft (wip), active (live), archived (hidden). Default draft on create; pass status=active to publish. Archive is idempotent.
Tags: update merges by default; pass tags_mode=replace to overwrite the whole set. Common tags: decision, pending, todo, directive, gotcha, cluster, reflect.

## Edges
related (default, idempotent), parent, develops, replaces (target blocked in frontier), contradicts (symmetric), supports (directed), cluster, references, depends_on.
No self-loops; one type per pair; cluster edges strict; a retype upgrades a related edge in place.
link takes thought_id (alias source_id) + target_id; merge takes source_id + target_id — one source/target vocabulary across both tools.
merge archives the source onto the target and returns {target, edges_transferred}: the count of source edges the target now holds. Dropped — and not counted — are a self-loop the merge would create, a duplicate non-symmetric edge, and a cluster edge the cluster rule rejects; an existing related/contradicts pair still counts, since the target now owns that relation.
unlink, retype, archive and merge are preview-first: dry-run returns status "preview" and requires confirm: true to execute. No cascade.
link_batch creates up to 1000 edges in one transaction and reports per item as {linked, failed, errors[]}; unlink_batch deletes/previews up to 1000 edges in one transaction, validates all ids exist before deleting any, and reports per edge as {deleted, preview, failed} with counts; archive_batch (memory_supersede) reports {archived, failed, errors[]}.

## Search
Modes: hybrid (default, RRF), vector, BM25. Filters: status, project, tag, cluster (only/exclude), min importance.
memory_recall action=list returns a paginated inventory without a query: filters status (draft/active/archived), project_id, tag, is_cluster (true=clusters only, false=non-clusters); paging limit (1-500, default 50) and offset; result {thoughts[], total, limit, offset} with total the un-paged count. Ordering is fixed (created_at desc); there is no sort parameter. Example: {"action":"list","status":"draft","limit":50,"offset":0}.
BM25 hits are immediate; vector/hybrid hits appear only after the embedder stores the vector in vec_thoughts (polls pending_embeddings every embedder.pollIntervalMs, default 7000 ms; visible ~10-15 s).
low_confidence: no BM25 anchor, or vector below search.confidence.vectorFloor. min_relevance gates weak vector-only hits (default 0 = all).
recency_weight (default 0) + recency_half_life_days (default 30) add recency_score/final_score when >0. supersession_mode (off/flag/suppress, default suppress) + contradiction_mode (off/flag, default flag).

## Lifecycle
Importance decays by decay.rate (default 0.95) per decay.intervalMs (default 24 h). Decay only lowers importance — it never archives.
Archiving is explicit (memory_supersede archive, or status=archived). TTL deletion is opt-in: only a positive ttl.archivedTtlDays deletes anything (default -1; 0 and negative values both disable it). Protected thoughts are never deleted.

## Scheduled jobs
Started in src/index.ts when the process owns background jobs: decay, ttl-cleanup, placement-retention. auto_cluster is on demand (memory_crystallize action=auto_cluster) and never scheduled.

## Projects and clusters
One project per thought. A cluster is a thought with is_cluster=1 whose cluster edges point at its members; cluster thoughts never enter the frontier.
memory_crystallize action=graph paginates nodes: offset (default 0), limit (default 500, max 2000); the response includes total (node count for the filters) alongside nodes/edges.
## Primers
A recalled thought whose hit count reaches primer.promoteThreshold (default 5) becomes a primer on the search path. memory_primers delete is preview-first (confirm=true); the HTTP DELETE is immediate.

## Health check
memory_status action=health; severity restricts reported findings, fix=true auto-repairs safe issues. Score: 100 - criticalCategories×40 - warningCategories×15 - scoredInfoOccurrences×0.25, clamped [0,100]. Islands are an informational coverage finding and are not scored, so publishing an unlinked thought never lowers the score.
contradiction_in_cluster remediation: memory_store action=unlink on the contradicts edge, or retype it to supports/related, or archive the cluster thought. Dry-run first, then confirm=true.

## Placement proposal and review
memory_status action=propose returns a read-only plan (placement, edges[], lifecycle) and never writes. memory_review enqueue/list/apply/apply_batch/rollback/reject; apply is dry-run unless confirm=true and re-checks staleness. The queue holds edge items only: a plan's placement and lifecycle items are reported as skipped.

## Session reflection
memory_reflect reflect writes thoughts, it is not read-only: decisions create active thoughts tagged decision + reflect; pending create draft thoughts tagged pending + reflect (surface after wake_days, default 7). The reflect tag marks every thought reflect created, so they can be filtered (search tag=reflect) or cleaned up without touching hand-created ones. summary appends to project_context; goals_delta adds/removes goals.`
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
