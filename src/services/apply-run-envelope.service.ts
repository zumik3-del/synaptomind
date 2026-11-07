/**
 * The run envelope of an explicit placement apply (ADR 2026-09-29 §2.7, §2.8):
 * the `run_id` an accepted row carries and the provenance payload that id is
 * stamped into. Without it an accepted row is a committed graph mutation that
 * no `rollback(run_id)` can reach, so the caller's id is used verbatim whenever
 * there is one and otherwise one is synthesized here and handed back.
 *
 * **Ordering is the caller's contract, not this module's.** `resolveApplyRunId`
 * must be called only AFTER the caller's dry-run branch, so a preview never
 * mints an id.
 *
 * `auto-` marks the envelope as synthesized in rows and logs — advisory only, a
 * caller id that happens to look like this still works.
 */

import type { PlacementProposalRow } from '../db/placement-proposals'

/** The synthesized half of the envelope (ADR 2026-09-29 D2). */
function autoRunId(): string {
  return `auto-${Bun.randomUUIDv7()}`
}

/**
 * The envelope of one confirming apply the caller did not group into a run: the
 * caller's id verbatim, or a synthesized one for an item the caller left
 * un-enveloped. Call this past the dry-run branch (see the module header).
 */
export function resolveApplyRunId(options: { runId?: string }): string {
  return options.runId ?? autoRunId()
}

/**
 * The one envelope a whole batch shares (ADR 2026-09-29 D5): the batch *is* the
 * run, so a single `rollback(run_id)` must revert everything it committed.
 * Synthesized only for a confirming batch the caller left un-enveloped and that
 * will decide at least one pending row — a dry-run decides nothing, and a batch
 * that decides nothing has no manifest to hand back.
 */
export function resolveBatchRunId(
  rows: Array<PlacementProposalRow | undefined>,
  options: { confirm?: boolean; runId?: string }
): string | undefined {
  const decidesPendingRow = rows.some(row => row !== undefined && row.state === 'pending')
  return options.runId ?? (options.confirm === true && decidesPendingRow ? autoRunId() : undefined)
}
