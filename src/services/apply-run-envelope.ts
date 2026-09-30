/**
 * The run envelope of an explicit placement apply (ADR 2026-09-29 §2.7, §2.8):
 * the `run_id` an accepted row carries and the provenance payload that id is
 * stamped into. Without it an accepted row is a committed graph mutation that
 * no `rollback(run_id)` can reach, so the caller's id is used verbatim whenever
 * there is one and otherwise one is synthesized here and handed back.
 *
 * **Ordering is the caller's contract, not this module's.** `resolveApplyRunId`
 * must be called only AFTER the caller's `run_id_required` triage refusal and
 * AFTER its dry-run branch. That ordering is the whole reason a synthesized id
 * can never satisfy the triage guard: by the time a resolving call site runs, a
 * triage item is guaranteed to carry a caller id, so the resolver never has to
 * inspect the item kind. `resolveBatchRunId` relies on the same guarantee from
 * the other side — `checkBatchGuards` has already refused a batch holding a
 * pending triage row without a `run_id`.
 *
 * `auto-` marks the envelope as synthesized in rows and logs — advisory only, a
 * caller id that happens to look like this still works.
 */

import type { PlacementProposalRow } from '../db/placement-proposals'
import { isTriageKind } from './apply-run-guards'

/** The synthesized half of the envelope (ADR 2026-09-29 D2). */
function autoRunId(): string {
  return `auto-${Bun.randomUUIDv7()}`
}

/**
 * The provenance envelope a triage apply records (ADR 2026-09-29 §2.3.4).
 * `run_id` is deliberately absent: the accepting branch stamps the resolved
 * envelope id into the stored JSON for every kind, so one place writes it.
 */
export function triageEnvelope(row: PlacementProposalRow, afterStatus: 'active' | 'archived'): Record<string, unknown> {
  return {
    before_status: 'draft',
    after_status: afterStatus,
    rule_id: row.rule_id,
    target_id: row.target_id
  }
}

/**
 * The envelope of one confirming apply the caller did not group into a run: the
 * caller's id verbatim, or a synthesized one for an item the caller left
 * un-enveloped. Call this past the `run_id_required` refusal (see the module
 * header) — a triage item then always carries a caller id, so there is no
 * "synthesize nothing" case to represent here.
 */
export function resolveApplyRunId(options: { runId?: string }): string {
  return options.runId ?? autoRunId()
}

/**
 * The one envelope a whole batch shares (ADR 2026-09-29 D5): the batch *is* the
 * run, so a single `rollback(run_id)` must revert everything it committed.
 * Synthesized only for a confirming batch the caller left un-enveloped and that
 * will decide at least one pending non-triage row — a dry-run decides nothing,
 * and a batch that decides nothing has no manifest to hand back.
 */
export function resolveBatchRunId(
  rows: Array<PlacementProposalRow | undefined>,
  options: { confirm?: boolean; runId?: string }
): string | undefined {
  const decidesPendingNonTriage = rows.some(row => row !== undefined && row.state === 'pending' && !isTriageKind(row.item_kind))
  return options.runId ?? (options.confirm === true && decidesPendingNonTriage ? autoRunId() : undefined)
}
