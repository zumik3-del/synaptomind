import type { StoredProposalItemKind } from '../db/placement-proposals'

export type PlannedWriter = 'createEdgeService'

export interface PlannedWriterCall {
  writer: PlannedWriter
  args: Record<string, string | string[] | undefined>
}

export interface ApplyOptions {
  confirm?: boolean
  decidedBy?: string
  now?: string
  runId?: string
  limit?: number
}

type RunRefusalCode = 'limit_exceeded' | 'unsupported_item_kind'

export interface RunRefusal {
  code: RunRefusalCode
  reason: string
}

interface ApplyResultBase {
  proposal_id: string
  item_kind: StoredProposalItemKind
}

interface DryRunApplyResult extends ApplyResultBase {
  status: 'dry_run'
  calls: PlannedWriterCall[]
}

export interface AcceptedApplyResult extends ApplyResultBase {
  status: 'accepted'
  idempotent: boolean
  calls: PlannedWriterCall[]
  result: string | null
  /** Synthesized when the caller supplied none; null only for rows accepted before ids existed. */
  run_id: string | null
}

interface StaleApplyResult extends ApplyResultBase {
  status: 'stale'
  reason: string
}

interface FailedApplyResult extends ApplyResultBase {
  status: 'failed'
  reason: string
}

export interface RefusedApplyResult extends ApplyResultBase {
  status: 'refused'
  refusal: RunRefusal
}

export type ApplyResult =
  | DryRunApplyResult
  | AcceptedApplyResult
  | StaleApplyResult
  | FailedApplyResult
  | RefusedApplyResult

export interface ApplyBatchOutcome {
  results: ApplyResult[]
  errors: Array<{ proposal_id: string; error: string }>
  refused?: RunRefusal
  run_id?: string | null
}

export interface RollbackOptions {
  confirm?: boolean
  decidedBy?: string
  now?: string
}

type RollbackItemAction = 'reverted' | 'skipped' | 'refused'

export interface RollbackItemReport {
  proposal_id: string
  item_kind: StoredProposalItemKind
  action: RollbackItemAction
  reason?: string
}

export interface RollbackReport {
  run_id: string
  confirm: boolean
  items: RollbackItemReport[]
  summary: { reverted: number; skipped: number; refused: number }
}
