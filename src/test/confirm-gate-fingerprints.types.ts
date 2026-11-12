/**
 * Shared vocabulary of the per-input fingerprint matrix (task #2492): the probe
 * shape, the change helpers every probe builds on, and the second objects an
 * identity probe addresses instead of the fixture's own.
 *
 * The probe data lives in `confirm-gate-fingerprints.edges.ts` (edge rows, runs
 * and placement proposals) and `confirm-gate-fingerprints.thoughts.ts`
 * (thoughts, clusters, projects, primers). Test-only.
 */
import type { Database } from 'bun:sqlite'
import { getDb } from '../db/container'
import { promoteThoughtToPrimer } from '../db/primers'
import { createProjectService } from '../services/projects.service'
import { seedEdge, seedThought } from './helpers'
import { edgeProposal } from './confirm-gate-cases.types'

/** A timestamp no fixture state is created with. */
export const DRIFTED_AT = '2000-01-01T00:00:00.000Z'
/** The subset of the seed fixture's clock an auto-cluster probe must keep. */
export const OLD = '2025-01-01T00:00:00.000Z'

export type RefusalReading = 'stale' | 'target_mismatch'

export interface FingerprintProbe {
  /** What the probe changes, for the failing case's name. */
  change: string
  /** How the token must read the change. */
  refusal: RefusalReading
  /** Change the input and return the confirm's arguments. */
  run: (args: Record<string, unknown>) => Record<string, unknown>
}

export interface FingerprintCase {
  /** The contract-matrix label this action is driven through (12↔12 binding). */
  label: string
  /** The token scope the action declares on its `runGuarded` call. */
  kind: string
  /** The `src/`-relative module holding that declaration. */
  module: string
  /** Probes per declared part, keyed by a substring identifying the part. */
  probes: Record<string, readonly FingerprintProbe[]>
}

export function db(): Database {
  return getDb()
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`missing string argument '${key}'`)
  return value
}

export function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`missing string array argument '${key}'`)
  }
  return value as string[]
}

export function update(sql: string, ...values: Array<string | number>): void {
  db()
    .prepare(sql)
    .run(...values)
}

/** Age a row's `created_at`/`updated_at` so a fingerprint that folds it moves. */
export function age(
  table: 'thoughts' | 'edges' | 'placement_proposals' | 'primers',
  column: string
) {
  return (id: string) => update(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, DRIFTED_AT, id)
}

/** One more thought, so an edge or a primer keeps its own row untouched. */
export function freshThought(label: string): string {
  return seedThought({ content: `gate fingerprint ${label}` })
}

/** A second object of the same kind, used to show an identity part is target-bound. */
export function anotherEdge(): string {
  return seedEdge(freshThought('bound source'), freshThought('bound target'), 'contradicts')
}

export function anotherPrimer(): string {
  const primer = promoteThoughtToPrimer(db(), freshThought('bound primer'), 7)
  if (primer === undefined) throw new Error('could not promote the second primer')
  return primer.id
}

export function anotherArchivedThought(): string {
  return seedThought({ content: 'gate fingerprint bound retention', status: 'archived' })
}

export function anotherProposal(): string {
  return edgeProposal(freshThought('bound proposal source'), freshThought('bound proposal target'))
}

export function anotherProject(): string {
  return createProjectService({
    name: `Gate fingerprint ${Bun.randomUUIDv7()}`,
    local_path: `/tmp/gate-fingerprint-${Bun.randomUUIDv7()}`
  }).id
}

/** The auto-cluster members the seed fixture planted, in the pool's own order. */
export function autoClusterMembers(): string[] {
  return (
    db()
      .prepare(
        "SELECT id FROM thoughts WHERE content LIKE 'gate cluster member%' AND status = 'active' ORDER BY created_at DESC, id"
      )
      .all() as Array<{ id: string }>
  ).map(row => row.id)
}

/** One accepted proposal of the rollback fixture's run, oldest first. */
export function acceptedRowId(runId: string): string {
  const row = db()
    .prepare(
      "SELECT id FROM placement_proposals WHERE run_id = ? AND state = 'accepted' ORDER BY created_at, id LIMIT 1"
    )
    .get(runId) as { id: string } | null
  if (row === null) throw new Error(`no accepted proposal in run ${runId}`)
  return row.id
}

/** A proposal column change, applied to one row of a batch or a single row. */
export function proposalColumn(column: string, value: string): (id: string) => void {
  return id => update(`UPDATE placement_proposals SET ${column} = ? WHERE id = ?`, value, id)
}
