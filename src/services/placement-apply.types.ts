/**
 * Public types for the explicit placement-proposal `apply` orchestrator and its
 * run-scoped `rollback` (ADR 2026-09-28 P8 §2.5–2.8 / R4; ADR 2026-09-29 §2.8).
 */

import type { StoredProposalItemKind } from '../db/placement-proposals'

/** Existing writer the orchestrator may call — never a new graph writer. */
export type PlannedWriter = 'createEdgeService'

/** The exact existing-service call `apply` would make (dry-run output). */
export interface PlannedWriterCall {
  writer: PlannedWriter
  args: Record<string, string | string[] | undefined>
}

export interface ApplyOptions {
  /** `true` executes the planned writer; absent/`false` is a non-mutating dry-run (ADR §2.10.3). */
  confirm?: boolean
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

/** Why an explicit apply/rollback refused the request (ADR 2026-09-29 §2.7). */
export type RunRefusalCode =
  | 'limit_exceeded'
  /** The row's item kind was removed from the queue (tasks #1942, #1946). */
  | 'unsupported_item_kind'

/** Typed refusal returned instead of a partial write; nothing was mutated. */
export interface RunRefusal {
  code: RunRefusalCode
  reason: string
}

interface ApplyResultBase {
  proposal_id: string
  /** The row's kind — a removed kind is possible in older installs (tasks #1942, #1946). */
  item_kind: StoredProposalItemKind
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
  /**
   * Run envelope the row was accepted under, echoed from `row.run_id` so the
   * caller can `rollback(run_id)` without a second query (ADR 2026-09-29 §2.7).
   * Never null for an apply the service accepted: a confirming apply that the
   * caller left un-enveloped gets a synthesized `auto-…` id. Null only when
   * re-reading a row accepted before ids were recorded.
   */
  run_id: string | null
}

export interface StaleApplyResult extends ApplyResultBase {
  status: 'stale'
  reason: string
}

export interface FailedApplyResult extends ApplyResultBase {
  status: 'failed'
  reason: string
}

/** Typed refusal (batch limit exceeded, removed item kind). No writer ran. */
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
  /**
   * The one run envelope every row this batch accepted shares, so a single
   * `rollback(run_id)` reverts the whole batch (ADR 2026-09-29 §2.7, §2.8).
   * The caller's own id when it supplied one, otherwise the synthesized
   * `auto-…` id; absent when the batch decided nothing that needs an envelope.
   */
  run_id?: string | null
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
  /** The row's kind — a removed kind is possible in older installs (task #1942). */
  item_kind: StoredProposalItemKind
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
