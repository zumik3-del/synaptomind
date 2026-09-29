/**
 * Deterministic draft-triage proposer (ADR 2026-09-29 §2.3.1).
 *
 * Turns one draft thought into a verdict — `activate` or `archive` — and
 * enqueues exactly one row into the existing `placement_proposals` queue
 * (`item_kind = triage_activate | triage_archive`). The module is a *reader*:
 * it reuses the engine's own candidate pool ({@link buildCandidatePool}) and
 * near-duplicate rule ({@link findMergeTarget}), never calls the embedder, and
 * writes only through `src/db/placement-proposals.ts`. Graph mutation stays the
 * explicit `apply` path's job (ADR §2.3.4); no writer is imported here.
 *
 * v1 rule table: exactly one rule, `duplicate.active_near_duplicate`, plus the
 * `default.activate` fallback. Rules are ordered, first match wins, and every
 * branch is deterministic (no model, no clock beyond `now`).
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { getEdgePairBetween } from '../db/edges'
import {
  countLivePendingProposals,
  findPendingByItem,
  insertProposal,
  type InsertProposalInput,
  type PlacementProposalRow,
  type ProposalItemKind
} from '../db/placement-proposals'
import { getThoughtRow, type Thought } from '../db/thoughts'
import { insertLog } from '../logging/log'
import { clamp01 } from '../utils'
import { createIntervalJob } from './jobs'
import { findMergeTarget } from './placement/lifecycle'
import { buildCandidatePool } from './placement/placement'
import { computeFingerprint, proposalExpiry } from './placement-proposals.mapping'

/** The two v1 verdicts; every other action needs a new ADR (ADR §2.11). */
export type TriageAction = 'activate' | 'archive'

/** Stable provenance id of a fired rule. */
export type TriageRuleId = 'duplicate.active_near_duplicate' | 'default.activate'

/** Best lexical near-duplicate shape returned by {@link findMergeTarget}. */
type MergeTarget = NonNullable<ReturnType<typeof findMergeTarget>>

/** Everything a rule may inspect; `mergeTarget` comes from the reused pool rule. */
export interface TriageContext {
  draft: Thought
  mergeTarget: MergeTarget | undefined
}

/**
 * One ordered triage rule, mirroring `EdgeTypeRule[]`
 * (`src/services/placement/edge-type-rules.ts`). First match wins; a rule that
 * returns an `archive` verdict is expected to carry the duplicate target in the
 * surrounding {@link TriageContext}.
 */
export interface TriageRule {
  id: TriageRuleId
  action: TriageAction
  predicate(ctx: TriageContext): boolean
  confidence(ctx: TriageContext): number
  rationale(ctx: TriageContext): string
}

/**
 * Ordered rule table, highest precedence first. v1 ships one rule; the
 * `activate` default is applied by {@link classifyDraft} when none match.
 */
export const TRIAGE_RULES: TriageRule[] = [
  {
    id: 'duplicate.active_near_duplicate',
    action: 'archive',
    predicate: ctx => ctx.mergeTarget !== undefined,
    confidence: ctx => (ctx.mergeTarget ? clamp01(ctx.mergeTarget.overlap) : 0),
    rationale: ctx =>
      ctx.mergeTarget
        ? `near-duplicate of active thought ${ctx.mergeTarget.id} (lexical overlap ${ctx.mergeTarget.overlap.toFixed(2)}); propose archive`
        : 'no active near-duplicate'
  }
]

/** Rule id of the `activate` fallback when no rule matches. */
export const DEFAULT_ACTIVATE_RULE_ID: TriageRuleId = 'default.activate'

/** Default backfill scan bound; see {@link runTriageBackfill}. */
export const DEFAULT_BACKFILL_LIMIT = 100

/** The deterministic classification of one draft. */
export interface TriageVerdict {
  action: TriageAction
  /** Duplicate target for `archive`; `null` for `activate`. */
  targetId: string | null
  confidence: number
  reason: string
  /** Lexical overlap with the duplicate target; `null` for `activate`. */
  overlap: number | null
  rule_id: TriageRuleId
  review_required: true
}

/** The `payload` persisted on a triage row. */
export interface TriagePayload {
  verdict: TriageAction
  reason: string
  overlap: number | null
  rule_id: TriageRuleId
  review_required: true
}

export interface TriageBackfillResult {
  /** Number of triage rows inserted/refreshed by this sweep. */
  enqueued: number
}

/**
 * A scheduled reminder must never be triaged (ADR §2.5): the `pending` tag or a
 * future `surface_after` marks it as intentionally deferred. `now` is the
 * comparison clock supplied by the caller, so the check is deterministic.
 *
 * The tag match is case-insensitive to stay consistent with the frontier query
 * (`lower(name) = 'pending'`): a `Pending`-tagged draft is a reminder there and
 * must be a reminder here too, or triage would archive a thought the frontier
 * still expects to surface.
 */
export function isScheduledReminder(t: Thought, now: string): boolean {
  if (t.tags.some(tag => tag.name.toLowerCase() === 'pending')) return true
  return t.surface_after !== null && t.surface_after > now
}

/** Guard at the enqueue seam: only plain drafts are triaged (ADR §2.3.2). */
function isTriageCandidate(t: Thought, now: string): boolean {
  return t.status === 'draft' && !t.is_cluster && !t.is_profile && !isScheduledReminder(t, now)
}

function itemKindFor(action: TriageAction): ProposalItemKind {
  return action === 'archive' ? 'triage_archive' : 'triage_activate'
}

/**
 * Classify one draft: reuse the engine's candidate pool and near-duplicate
 * rule, then apply the ordered rule table with the `activate` fallback. Pure
 * and synchronous — no embedder, no graph write.
 */
export function classifyDraft(draft: Thought, d: Database = getDb()): TriageVerdict {
  const pool = buildCandidatePool(d, draft, draft.project_id, config.edgeDetect.maxCandidates)
  const mergeTarget = findMergeTarget(pool, draft)
  const ctx: TriageContext = { draft, mergeTarget }

  for (const rule of TRIAGE_RULES) {
    if (!rule.predicate(ctx)) continue
    return {
      action: rule.action,
      targetId: rule.action === 'archive' ? (mergeTarget?.id ?? null) : null,
      confidence: rule.confidence(ctx),
      reason: rule.rationale(ctx),
      overlap: rule.action === 'archive' ? (mergeTarget?.overlap ?? null) : null,
      rule_id: rule.id,
      review_required: true
    }
  }

  return {
    action: 'activate',
    targetId: null,
    confidence: 0,
    reason: 'no rule matched; activate the draft',
    overlap: null,
    rule_id: DEFAULT_ACTIVATE_RULE_ID,
    review_required: true
  }
}

/**
 * Staleness fingerprint (ADR §2.2), reusing {@link computeFingerprint} so it
 * matches the opaque recipe `isProposalStale` recomputes at read/apply time:
 * source-only for `activate`, source+target pair for `archive`.
 */
function triageFingerprint(d: Database, draft: Thought, targetId: string | null): string {
  if (targetId === null) {
    return computeFingerprint({
      sourceId: draft.id,
      sourceUpdatedAt: draft.updated_at,
      sourceStatus: draft.status,
      targetId: '',
      targetUpdatedAt: '',
      targetStatus: '',
      existingEdgeType: null
    })
  }
  const target = getThoughtRow(d, targetId)
  return computeFingerprint({
    sourceId: draft.id,
    sourceUpdatedAt: draft.updated_at,
    sourceStatus: draft.status,
    targetId,
    targetUpdatedAt: target?.updated_at ?? '',
    targetStatus: target?.status ?? '',
    existingEdgeType: getEdgePairBetween(d, draft.id, targetId)?.type ?? null
  })
}

/**
 * Enqueue exactly one triage row for a plain draft (ADR §2.3.1). Returns `null`
 * when the guard rejects the thought (non-draft, cluster/profile, reminder) or
 * when the documented `triage.enabled` master switch is off; dedup/refresh for
 * the same `(source, kind, target)` is delegated to `insertProposal`'s partial
 * unique index.
 *
 * This is the single seam every triage producer goes through — the create path
 * in `thoughts.service.ts` and the backfill sweep below — so the master switch
 * is honoured in exactly one place.
 */
export function enqueueTriageItem(draft: Thought, d: Database = getDb()): PlacementProposalRow | null {
  if (!config.triage.enabled) return null
  const now = new Date().toISOString()
  if (!isTriageCandidate(draft, now)) return null

  const verdict = classifyDraft(draft, d)
  const payload: TriagePayload = {
    verdict: verdict.action,
    reason: verdict.reason,
    overlap: verdict.overlap,
    rule_id: verdict.rule_id,
    review_required: true
  }

  const input: InsertProposalInput = {
    project_id: draft.project_id,
    source_thought_id: draft.id,
    item_kind: itemKindFor(verdict.action),
    target_id: verdict.targetId,
    edge_type: null,
    lifecycle_action: null,
    direction: null,
    confidence: verdict.confidence,
    rationale: verdict.reason,
    rule_id: verdict.rule_id,
    payload: JSON.stringify(payload),
    fingerprint: triageFingerprint(d, draft, verdict.targetId),
    expires_at: proposalExpiry(now)
  }

  // Backpressure: triage writes into the same queue as ordinary placement, so
  // it is bound by `maxPendingProposals` too — otherwise an ambient create
  // storm grows the table past the cap and then blocks every ordinary enqueue.
  // A refresh of an item that already has a live row is not a new row and stays
  // allowed at the cap; a genuinely new item is skipped rather than thrown, so
  // the create seam and the backfill sweep keep working. The sweep is
  // idempotent, so a later sweep enqueues this draft once the queue drains
  // (ADR 2026-09-28 §2.4).
  const isNew = findPendingByItem(d, input) === undefined
  if (isNew && countLivePendingProposals(d, now) >= config.placement.maxPendingProposals) return null

  return insertProposal(d, input)
}

/**
 * Drafts with no live/accepted triage row, newest first. The `NOT EXISTS`
 * clause is the backfill's idempotence key; the enqueue itself is additionally
 * deduped by `idx_pp_dedup`.
 */
function findUntriagedDrafts(d: Database, limit: number): Thought[] {
  const rows = d
    .prepare(
      `SELECT t.id FROM thoughts t
        WHERE t.status = 'draft'
          AND COALESCE(t.is_cluster, 0) = 0
          AND COALESCE(t.is_profile, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM placement_proposals p
            WHERE p.source_thought_id = t.id
              AND p.item_kind IN ('triage_activate', 'triage_archive')
              AND p.state IN ('pending', 'accepted')
          )
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`
    )
    .all(Math.floor(limit)) as Array<{ id: string }>

  const drafts: Thought[] = []
  for (const row of rows) {
    const thought = getThoughtRow(d, row.id)
    if (thought) drafts.push(thought)
  }
  return drafts
}

/**
 * Bounded, idempotent crash-safety sweep (ADR §2.3.3): enqueue triage items for
 * drafts that have no live/accepted triage row yet, up to `limit`. Re-running
 * it enqueues nothing new (the `NOT EXISTS` filter plus the dedup index).
 */
export function runTriageBackfill(
  limit: number = DEFAULT_BACKFILL_LIMIT,
  d: Database = getDb()
): TriageBackfillResult {
  const now = new Date().toISOString()
  let enqueued = 0
  for (const draft of findUntriagedDrafts(d, limit)) {
    if (!isTriageCandidate(draft, now)) continue
    if (enqueueTriageItem(draft, d)) enqueued++
  }
  return { enqueued }
}

/**
 * Periodic self-healing sweep (ADR 2026-09-29 §2.3.3), gated by the
 * `triage.enabled` master switch and `config.triage.backfillEnabled` (default
 * true) and bounded by `config.triage.maxItemsPerRun`. Mirrors the existing
 * interval-job pattern (`decay.service.ts`, `placement-retention.service.ts`);
 * the sweep itself is idempotent, so a re-run enqueues 0.
 */
const backfillJob = createIntervalJob(
  {
    name: 'triage-backfill',
    intervalMs: config.ttl.cleanupIntervalMs,
    guard: () => config.triage.enabled && config.triage.backfillEnabled,
    onError: err => insertLog('warning', 'triage', 'Triage backfill job failed', { error: String(err) })
  },
  () => {
    const { enqueued } = runTriageBackfill(config.triage.maxItemsPerRun)
    if (enqueued > 0) {
      insertLog('info', 'triage', `Triage backfill enqueued ${enqueued} items`, { count: enqueued.toString() })
    }
  }
)

export function startTriageBackfillJob(): void { backfillJob.start() }
export function stopTriageBackfillJob(): void { backfillJob.stop() }
