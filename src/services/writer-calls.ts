/**
 * Shared writer-call planner for the explicit placement apply/rollback
 * orchestrators (ADR 2026-09-28 P8 §2.5–2.6).
 *
 * Apply (forward) and rollback (inverse) both dispatch on a proposal row's
 * `item_kind` to the same small set of existing writers, in the same order. This
 * module owns that dispatch once: {@link planWriterCalls} turns a row into the
 * call(s) it implies, and each orchestrator executes that plan through the
 * writers it imports — apply forward (`createEdgeService`), rollback inverse
 * (`deleteEdgeService`). Planning is pure and never touches the graph, so the
 * non-mutating dry-run reuses it unchanged.
 *
 * Since task #1946 `edge` is the only live kind: every other kind was removed
 * from the queue (`placement`/`lifecycle` in #1942, the two triage verdicts in
 * #1946) and a row of a removed kind has no writer action here — the
 * orchestrators refuse it instead.
 */

import type { PlacementProposalRow } from '../db/placement-proposals'
import type { PlannedEdge } from './apply-gates'

/** Which way a plan runs: forward apply or inverse rollback. */
export type WriterDirection = 'apply' | 'rollback'

/** A planned existing-writer invocation; rollback adds the inverse-only `deleteEdgeService`. */
export type WriterCall =
  | { writer: 'createEdgeService'; args: { sourceId: string; targetId: string; type: string } }
  | { writer: 'deleteEdgeService'; args: { id: string } }

/** The apply direction never plans the rollback-only `deleteEdgeService`. */
export type ApplyWriterCall = Exclude<WriterCall, { writer: 'deleteEdgeService' }>

/** Parse a stored proposal `result` JSON without throwing on legacy/null values. */
export function parseResult(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The id of an edge an apply created, when its stored `result` recorded one. */
export function createdEdgeId(row: PlacementProposalRow): string | undefined {
  const value = parseResult(row.result).edge_id
  return typeof value === 'string' ? value : undefined
}

/**
 * Plan the existing-writer call(s) one row implies in `direction`, or
 * `undefined` when the row kind has no writer action at all — a malformed row
 * the caller must reject rather than execute as a no-op. `edge` is the pair the
 * forward direction would write (`plannedEdge`); rollback ignores it.
 */
export function planWriterCalls(
  row: PlacementProposalRow,
  direction: WriterDirection,
  edge?: PlannedEdge
): WriterCall[] | undefined {
  if (row.item_kind === 'edge') {
    if (direction === 'rollback') {
      const edgeId = createdEdgeId(row)
      return edgeId ? [{ writer: 'deleteEdgeService', args: { id: edgeId } }] : []
    }
    if (!edge) return undefined
    return [{ writer: 'createEdgeService', args: { sourceId: edge.sourceId, targetId: edge.targetId, type: edge.type } }]
  }

  return undefined
}
