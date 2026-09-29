/**
 * Public types for the explicit placement-proposal `apply` orchestrator
 * (ADR 2026-09-28 P8, §2.5–2.8 / R4).
 */

import type { ProposalItemKind } from '../db/placement-proposals'

/** Existing writer the orchestrator may call — never a new graph writer. */
export type PlannedWriter = 'createEdgeService' | 'mergeThoughtsService' | 'archiveThoughtById'

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

export type ApplyResult = DryRunApplyResult | AcceptedApplyResult | StaleApplyResult | FailedApplyResult

export interface ApplyBatchOutcome {
  results: ApplyResult[]
  errors: Array<{ proposal_id: string; error: string }>
}
