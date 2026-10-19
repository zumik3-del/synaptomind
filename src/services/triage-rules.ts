/**
 * The deterministic triage rule table (ADR 2026-09-29 §2.3.1), split out of
 * `triage.service.ts` so that module keeps the classify/enqueue/backfill
 * orchestration and stays under the project's 350-line file convention
 * (AGENTS.md §4).
 *
 * A rule is a pure predicate over a {@link TriageContext}: it reads the draft
 * and the near-duplicate target the reused placement pool produced, and returns
 * a verdict. Nothing here touches the database or the queue, so the table can be
 * read (and extended) without the enqueue machinery.
 *
 * Types are imported type-only, so there is no runtime edge back to
 * `triage.service.ts` (erased under `isolatedModules`); `triage.service.ts`
 * re-exports every symbol below, so callers keep importing them from there.
 */

import type { Thought } from '../db/thoughts'
import { clamp01 } from '../utils'
import type { findMergeTarget } from './placement/lifecycle'

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
 * `activate` default is applied by `classifyDraft` when none match.
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