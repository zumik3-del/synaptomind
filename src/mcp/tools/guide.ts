import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { toolOutputShape } from './utils'

function buildGuideText(softLimit: number): string {
  return `# SynaptoMind — Reference

## Quick Reference
| Concept | Tool | Action |
|---|---|---|
| Capture | memory_store | create |
| Find | memory_recall | search/get/context/chain/clusters |
| Connect | memory_store | link |
| Edit edges | memory_store | unlink/retype |
| Group | memory_crystallize | cluster/auto_cluster |
| Maintain clusters | memory_crystallize | cluster_remove/cluster_dissolve |
| Plan | memory_status | propose |
| Review | memory_review | enqueue/list/apply/apply_batch/rollback/reject |
| Prioritize | memory_status | frontier |
| Maintain | memory_status | health |
| Reflect | memory_reflect | reflect |
| Supersede | memory_supersede | archive/merge |
| Projects | memory_manage | list/create/update/delete/resolve |

## Runtime tools
| Tool | Actions | Purpose |
|---|---|---|
| memory_recall | search, get, context, chain, clusters | Find and retrieve thoughts |
| memory_store | create, update, link, unlink, retype | Write, connect and edit thoughts |
| memory_supersede | archive, merge | Version and supersede thoughts |
| memory_status | slots, frontier, profile, config, health, edge_suggestions, propose, cleanup | Query system state |
| memory_manage | list, create, update, delete, resolve | Project management |
| memory_review | enqueue, list, apply, apply_batch, rollback, reject | Review and apply queued placement proposals |
| memory_crystallize | graph, cluster, auto_cluster, cluster_remove, cluster_dissolve | Visualize and reorganize clusters |
| memory_reflect | reflect, timeline | Session management |
| memory_telemetry | query, analyze, primers | Analytics and self-improvement |
| memory_guide | (no action) | This reference text |

## Thoughts
Fields: content (≤${softLimit} soft), tags[], status, project_id, is_cluster, is_profile, source.
Status: draft (wip; pending-tagged drafts surface in frontier), active (live), archived (hidden). Default draft on create; pass status=active to publish. Profile thoughts not archivable. Archive idempotent. TTL cleanup after retention.
Tags: update replaces the whole tag set unless tags_mode=merge. System tags: @profile*, decision, pending, todo, directive, gotcha, cluster, crystal.

## Edges
| Type | When to use |
|---|---|
| related | General association. Default. Idempotent (duplicates reused) |
| parent | Hierarchical decomposition. Source=parent, target=child |
| develops | Conceptual evolution. Source evolves into target |
| replaces | Source supersedes target. Target blocked in frontier |
| contradicts | Two live, mutually exclusive claims. Symmetric (A↔B), neither authoritative |
| supports | Source provides evidence for target. Directed |
| cluster | Cluster → member. Only from cluster thoughts (is_cluster=1) |
| references | Cluster ↔ cluster. Mutual link between clusters |
| depends_on | Source blocked until target done. Affects frontier ranking

Constraints: no self-loops; one type per pair; cluster edges strict; related/contradicts idempotent both ways; linking a pair that already has a related edge with a specific type upgrades the placeholder.
Editing: unlink (idempotent; missing edge → not_found), retype (new id, created_at preserved); both dry-run first, then confirm=true. No cascade.

## Search
Modes: hybrid (default, vector+BM25 RRF), vector (semantic), BM25 (keywords).
Filters: status, project, tag, cluster (only/exclude), min importance.
Embedding delay: BM25 (FTS5) immediate; vector/hybrid only after embedder stores vector in vec_thoughts (polls pending_embeddings every embedder.pollIntervalMs, default 7000 ms; visible ~10-15 s).
Confidence: low_confidence hint (no bm25 anchor / vector below vectorFloor). min_relevance gate drops weak vector-only hits (default 0 = all).
Recency: recency_weight (default 0) + recency_half_life_days (default 30); adds recency_score/final_score when >0.
Standing: supersession_mode (off/flag/suppress, default suppress) + contradiction_mode (off/flag, default flag); contradicted rows never suppressed.
Post-processing: hit counting → primer promotion/hoisting → profile hoisting.

## Lifecycle
Importance starts 1.0; edges +0.1, primer promotion +0.15; decays by decay.rate (default 0.95) per decay.intervalMs (default 24 h). Auto-archive: importance < decay.archiveThreshold (0.1) AND age > decay.archiveMinAgeDays (30) AND status=active AND not profile.

## Projects vs Clusters
| | Projects | Clusters |
|---|---|---|
| Purpose | Organizational containers | Semantic groupings |
| Cardinality | One project per thought | One cluster per thought (enforced) |
| Deletion | Thoughts moved to Default | N/A |
| Frontier | Included | Excluded |

## Nightly normalization
| Job | What it does | Key config |
|---|---|---|
| decay | Decays importance, auto-archives stale thoughts | rate, archiveThreshold, archiveMinAgeDays |
| auto-cluster | Groups similar thoughts into clusters (Union-Find) | minAgeDays, minSimilarity, minMembers, dry_run |
| auto-link | Creates related edges for low-connectivity thoughts | minSimilarity, maxEdgesPerRun, dry_run |
| self-improve | Detects issues, auto-corrects (orphan writes, stale drafts) | enabled (default false) |

dry_run defaults to config (autoCluster.dryRun / autoLink.dryRun, default false), so a run mutates unless preview is requested explicitly. Decay and self-improve run on intervals (default 24 h); auto-cluster and auto-link are invoked on demand. All four are normalization passes and log their run.

## Health Check
Run memory_status (action=health); fix=true auto-repairs safe issues.
Categories: structural integrity, cluster health, connectivity (islands), content quality, semantic consistency, data drift.
Score: 100 - criticalCategories×40 - warningCategories×15 - infoOccurrences×0.25, clamped [0,100]. Critical/warning counted per category (0/1 each); info per occurrence. issues counts are raw occurrences and may be large while the score stays high. severity filter restricts reported checks but score is computed on the unfiltered result.
Trade-offs on dense graphs (do not fix by mutating): overlinked_thoughts (curated hubs), clusterless_dense_thoughts (age-gated). ADR: synaptomind/adr/2026-09-28-928-health-overlinked-clusterless-adr.md.
Remediating contradiction_in_cluster: unlink on contradicts_edge_id, or retype to supports/related, or cluster_remove a member. All dry-run first, then confirm=true.

## Edge Suggestions
Read-only candidate pairs (always type related, review_required). Confirm explicitly with memory_store (action=link). Embedder down degrades to empty result (degraded=true). Config: edgeDetect.minSimilarity, topK, maxCandidates, maxProposals.

## Placement Proposal
Read-only plan for a thought (thought_id) or draft (content): placement, edges[], lifecycle, degraded, generated_at. Every element carries rationale, confidence (ordinal), review_required. lifecycle.action ∈ {keep, link, merge, replaces+archive}; blocked_by[] explains unconfirmable moves. Pairs already carrying an edge are excluded.
Engine is a filter, never a source of truth; it never writes. Confirm via writers (link/merge/archive/cluster) or queue with memory_review.
memory_review: enqueue (persisted thought only), list (state/item_kind filters), apply/apply_batch/rollback/reject. apply is dry-run unless confirm=true; re-checks staleness fingerprint and cluster-size gates; stale items marked stale, never auto-repaired. Triage items (triage_activate/triage_archive) require run_id; per-run caps apply; dry-run first when triage.requireDryRunFirst. rollback reverses reversible mutations (not merge).

## Session Reflection
memory_reflect (action=reflect): summary appends to project_context; goals_delta add/remove (prefix "closed:" to remove); decisions create active thoughts tagged decision; pending create draft thoughts tagged pending (surface after wake_days, default 7).

## Profile
Mark thoughts is_profile=1 with @profile tag; sub-tags @profile-work, @profile-preferences. Never auto-archived. Use memory_status (action=profile) for persona stats.`
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
