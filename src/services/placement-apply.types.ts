/**
 * Public types for the explicit placement-proposal `apply` orchestrator and its
 * run-scoped `rollback` (ADR 2026-09-28 P8 §2.5–2.8 / R4; ADR 2026-09-29 §2.8).
 */

import type { ProposalItemKind } from '../db/placement-proposals'

/** Existing writer the orchestrator may call — never a new graph writer. */
export type PlannedWriter = 'createEdgeService' | 'mergeThoughtsService' | 'archiveThoughtById' | 'updateThoughtById'

/** The exact existing-service call `apply` would make (dry-run output). */
export interface PlannedWriterCall {
  writer: PlannedWriter
  args: Record<string, string | string[] | undefined>
}

export interface ApplyOptions {
  /** `true` executes the planned writer; absent/`false` is a non-mutating dry-run (ADR §2.10.3). */
  confirm?: boolean
  /** Override for a `placement`/`kind=parent` item (ADR OQ-4, default `parent`). */
  edgeType?: string
  /** Optional merged content for a `merge` lifecycle item. */
  mergedContent?: string
  /** Optional merged tags for a `merge` lifecycle item. */
  mergedTags?: string[]
  /** Agent/tool that applied the item (audit, ADR §2.8). */
  decidedBy?: string
  /** Clock override for deterministic tests (default now). */
  now?: string
  /**
   * Run envelope id grouping every row accepted by one explicit run; persisted
   * on the row so `rollback(run_id)` can find the manifest (ADR 2026-09-29 §2.3.4).
   */
  runId?: string
  /** `apply_batch`: max items this call may apply (excess is refused, never truncated). */
  limit?: number
}

/** Why a run-scoped guard refused an explicit apply/rollback (ADR 2026-09-29 §2.7). */
export type RunRefusalCode =
  | 'run_id_required'
  | 'dry_run_required'
  | 'limit_exceeded'
  | 'max_items_exceeded'
  | 'max_archives_exceeded'
  | 'max_links_exceeded'

/** Typed refusal returned instead of a partial write; nothing was mutated. */
export interface RunRefusal {
  code: RunRefusalCode
  reason: string
}

interface ApplyResultBase {
  proposal_id: string
  item_kind: ProposalItemKind
}

export interface DryRunApplyResult extends ApplyResultBase {
  status: 'dry_run'
  calls: PlannedWriterCall[]
}

export interface AcceptedApplyResult extends ApplyResultBase {
  status: 'accepted'
  /** `true` when the requested graph state already held (no writer ran). */
  idempotent: boolean
  calls: PlannedWriterCall[]
  result: string | null
}

export interface StaleApplyResult extends ApplyResultBase {
  status: 'stale'
  reason: string
}

export interface FailedApplyResult extends ApplyResultBase {
  status: 'failed'
  reason: string
}

/** Typed refusal (missing `run_id`, cap/limit exceeded, dry-run-first). No writer ran. */
export interface RefusedApplyResult extends ApplyResultBase {
  status: 'refused'
  refusal: RunRefusal
}

export type ApplyResult = DryRunApplyResult | AcceptedApplyResult | StaleApplyResult | FailedApplyResult | RefusedApplyResult

export interface ApplyBatchOutcome {
  results: ApplyResult[]
  errors: Array<{ proposal_id: string; error: string }>
  /** Present when the whole batch was refused before any item ran (no partial surprise). */
  refused?: RunRefusal
}

/** Options for the run-scoped rollback (ADR 2026-09-29 §2.8). */
export interface RollbackOptions {
  /** `true` executes the inverse writers; absent/`false` is a non-mutating dry-run report. */
  confirm?: boolean
  /** Agent/tool that requested the rollback (audit). */
  decidedBy?: string
  /** Clock override for deterministic tests (default now). */
  now?: string
}

/** What the rollback did (or would do) with one accepted row of the run. */
export type RollbackItemAction = 'reverted' | 'skipped' | 'refused'

export interface RollbackItemReport {
  proposal_id: string
  item_kind: ProposalItemKind
  action: RollbackItemAction
  reason?: string
}

export interface RollbackReport {
  run_id: string
  /** `false` for the default dry-run preview (nothing mutated). */
  confirm: boolean
  items: RollbackItemReport[]
  summary: { reverted: number; skipped: number; refused: number }
}
