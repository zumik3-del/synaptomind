/**
 * Shared vocabulary of the confirm-gate fixture matrix (task #2466).
 *
 * The case builders live in `confirm-gate-cases.edges.ts` and
 * `confirm-gate-cases.thoughts.ts`; this module holds the shape they fill and
 * the small DB probes they assert with. Test-only.
 */
import { expect } from 'bun:test'
import { getDb } from '../db/container'
import { getEdgePairBetween } from '../db/edges'
import { applyProposalService } from '../services/placement-apply.service'
import { insertPendingEdge } from './proposal-apply-helpers'

export type GateKind = 'edge' | 'thought' | 'batch' | 'other'

export interface GateCase {
  label: string
  /** What the token is bound to: edges, single thoughts/rows, batches, or a global/project target. */
  kind: GateKind
  tool: string
  /** Build a fresh fixture and return the preview arguments. */
  setup: () => Record<string, unknown>
  /** The guarded mutation ran exactly once. */
  assertMutated: () => void
  /** The guarded mutation did not run (preview or refused confirm). */
  assertUntouched: () => void
  /** Change fingerprint-relevant state and return the confirm arguments. */
  drift: (args: Record<string, unknown>) => Record<string, unknown>
  replay: 'token' | 'domain'
}

/** Old enough for every age-gated pool in the matrix. */
export const OLD = '2025-01-01T00:00:00.000Z'
export const ROLLBACK_RUN = 'gate-matrix-rollback-run'

export function edgeExists(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM edges WHERE id = ?').get(id) !== null
}

export function edgeTypeBetween(source: string, target: string): string | null {
  return getEdgePairBetween(getDb(), source, target)?.type ?? null
}

export function thoughtStatus(id: string): string | null {
  const row = getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(id) as {
    status: string
  } | null
  return row?.status ?? null
}

export function thoughtContent(id: string): string | null {
  const row = getDb().prepare('SELECT content FROM thoughts WHERE id = ?').get(id) as {
    content: string
  } | null
  return row?.content ?? null
}

export function thoughtExists(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM thoughts WHERE id = ?').get(id) !== null
}

/** Move a thought's `updated_at`, which every thought fingerprint folds in. */
export function ageThought(id: string): void {
  getDb()
    .prepare("UPDATE thoughts SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
    .run(id)
}

export function proposalState(id: string): string | null {
  const row = getDb().prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as {
    state: string
  } | null
  return row?.state ?? null
}

/** A pending edge proposal; with a `runId`, accept it so it joins that run's manifest. */
export function edgeProposal(source: string, target: string, runId?: string): string {
  const row = insertPendingEdge(getDb(), source, target)
  if (runId !== undefined) {
    const applied = applyProposalService(
      row.id,
      { confirm: true, runId, decidedBy: 'confirm-gate-test' },
      getDb()
    )
    expect(applied.status).toBe('accepted')
  }
  return row.id
}

export function clusterCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM thoughts WHERE is_cluster = 1').get() as {
      n: number
    }
  ).n
}

export function primerExists(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM primers WHERE id = ?').get(id) !== null
}
