import type { PlacementProposalRow } from '../db/placement-proposals'

function autoRunId(): string {
  return `auto-${Bun.randomUUIDv7()}`
}

// Call only past the caller's dry-run branch: a preview must never mint an id.
export function resolveApplyRunId(options: { runId?: string }): string {
  return options.runId ?? autoRunId()
}

export function resolveBatchRunId(
  rows: Array<PlacementProposalRow | undefined>,
  options: { confirm?: boolean; runId?: string }
): string | undefined {
  const decidesPendingRow = rows.some(row => row !== undefined && row.state === 'pending')
  return options.runId ?? (options.confirm === true && decidesPendingRow ? autoRunId() : undefined)
}
