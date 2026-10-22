import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { toolOutputShape } from './utils'

function buildGuideText(softLimit: number): string {
  return `# SynaptoMind — Reference

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
| memory_primers | list, delete | Manage the always-at-hand set (primers) |
| memory_guide | (no action) | This reference text |

## Thoughts
Fields: content (≤${softLimit} soft), tags[], status, project_id, is_cluster, is_profile, source.
Status: draft (wip; pending-tagged drafts surface in frontier), active (live), archived (hidden). Default draft on create; pass status=active to publish. Profile thoughts not archivable. Archive idempotent. TTL cleanup after retention.
Tags: update merges tags by default; pass tags_mode=replace to overwrite the whole set. System tags: @profile*, decision, pending, todo, directive, gotcha, cluster, crystal.

## Edges
| Type | When to use |
|---|---|
| related | General association. Default. Idempotent |
| parent | Hierarchical decomposition (source=parent) |
| develops | Conceptual evolution |
| replaces | Source supersedes target; target blocked in frontier |
| contradicts | Mutually exclusive claims. Symmetric (A↔B) |
| supports | Source provides evidence for target (directed) |
| cluster | Cluster → member (is_cluster=1) |
| references | Cluster ↔ cluster |
| depends_on | Source blocked until target done

Constraints: no self-loops; one type per pair; cluster edges strict; related/contradicts idempotent; existing related edge upgrades when retyped.
Editing: unlink (idempotent; missing edge → not_found), retype (new id, created_at preserved); both dry-run first, then confirm=true. No cascade.

## Search
Modes: hybrid (default, RRF), vector, BM25.
Filters: status, project, tag, cluster (only/exclude), min importance.
Embedding delay: BM25 (FTS5) immediate; vector/hybrid only after embedder stores vector in vec_thoughts (polls pending_embeddings every embedder.pollIntervalMs, default 7000 ms; visible ~10-15 s).
Confidence: low_confidence hint (no bm25 anchor / vector below vectorFloor). min_relevance gate drops weak vector-only hits (default 0 = all).
Recency: recency_weight (default 0) + recency_half_life_days (default 30); adds recency_score/final_score when >0.
Standing: supersession_mode (off/flag/suppress, default suppress) + contradiction_mode (off/flag, default flag).

## Lifecycle
Importance starts 1.0; edges +0.1, primer promotion +0.15; decays by decay.rate (default 0.95) per decay.intervalMs (default 24 h). Auto-archive: importance<0.1 AND age>30d AND active AND non-profile.

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

dry_run defaults to config (default false), so a run mutates unless previewed. Decay runs on an interval (24h); auto-cluster/auto-link on demand.

## Primers
memory_primers (action=list) returns the always-at-hand set; action=delete is preview-first: without confirm=true it only reports what would be removed, with confirm=true it deletes. The HTTP DELETE /api/primers/:id stays immediate.
Primers are created automatically: a recalled thought whose hit count reaches primer.promoteThreshold (default 5) becomes a primer.

## Health Check
Run memory_status (action=health); fix=true auto-repairs safe issues.
Categories: structural, cluster, connectivity, content, semantic, drift.
Score: 100 - criticalCategories×40 - warningCategories×15 - infoOccurrences×0.25, clamped [0,100]. Critical/warning counted per category (0/1 each); info per occurrence. issues counts are raw occurrences and may be large while the score stays high. severity filter restricts reported checks but score is computed on the unfiltered result.
Trade-offs on dense graphs (do not fix by mutating): overlinked_thoughts (curated hubs), clusterless_dense_thoughts (age-gated). ADR: synaptomind/adr/2026-09-28-928-health-overlinked-clusterless-adr.md.
Remediating contradiction_in_cluster: unlink on contradicts_edge_id, or retype to supports/related, or cluster_remove a member. All dry-run first, then confirm=true.

## Edge Suggestions
Read-only candidate pairs (always related, review_required). Confirm via memory_store link. Embedder down → empty (degraded=true). Config: edgeDetect.minSimilarity, topK, maxCandidates, maxProposals.

## Placement Proposal
Read-only plan for a thought or draft: placement, edges[], lifecycle, degraded. Carries rationale, confidence, review_required. lifecycle ∈ {keep,link,merge,replaces+archive}. Excludes pairs already edged.
Never writes; confirm via writers or memory_review. memory_review: enqueue/list/apply/apply_batch/rollback/reject; apply dry-run unless confirm=true; re-checks staleness/cluster gates; stale items marked stale. Triage needs run_id + caps; rollback reverses reversible mutations (not merge).

## Session Reflection
memory_reflect (action=reflect): summary appends to project_context; goals_delta add/remove (prefix "closed:" to remove); decisions create active thoughts tagged decision; pending create draft thoughts tagged pending (surface after wake_days, default 7).

## Profile
Mark thoughts is_profile=1 with @profile tag (sub-tags @profile-work, @profile-preferences). Never auto-archived. Use memory_status (action=profile).`
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
