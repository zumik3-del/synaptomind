import type { Database } from 'bun:sqlite'
import { getThoughtRow, type Thought } from './thoughts'

/**
 * Item classes the queue creates and applies (ADR §2.1). `triage_activate` /
 * `triage_archive` are the deterministic draft-triage verdicts (ADR 2026-09-29 §2.2).
 *
 * `placement` and `lifecycle` were removed in task #1942: they never occurred
 * in production, so the queue now handles `edge` proposals (plus the triage
 * verdicts) only.
 */
export type ProposalItemKind = 'edge' | 'triage_activate' | 'triage_archive'

/**
 * Item kinds the queue no longer creates (task #1942). Rows of these kinds may
 * still exist in installs upgraded from an older version: they stay readable
 * (their state is shown in `list`) but can never be applied or rolled back.
 */
export type LegacyProposalItemKind = 'placement' | 'lifecycle'

/** Every kind a stored row can carry — the live kinds plus the removed ones. */
export type StoredProposalItemKind = ProposalItemKind | LegacyProposalItemKind

/** Is this a kind the queue no longer supports (task #1942)? */
export function isLegacyItemKind(kind: string): kind is LegacyProposalItemKind {
  return kind === 'placement' || kind === 'lifecycle'
}

/**
 * Queue lifecycle: `pending` is live, every other state is terminal (ADR §2.2).
 * `rolled_back` marks rows reverted by an explicit run rollback (ADR 2026-09-29 §2.8).
 */
export type ProposalState = 'pending' | 'accepted' | 'rejected' | 'expired' | 'stale' | 'rolled_back'

export interface PlacementProposalRow {
  id: string
  project_id: string | null
  source_thought_id: string
  /** The stored kind — a removed kind is possible in older installs (task #1942). */
  item_kind: StoredProposalItemKind
  target_id: string | null
  edge_type: string | null
  lifecycle_action: string | null
  direction: string | null
  confidence: number
  rationale: string
  rule_id: string | null
  payload: string
  /** Run envelope of the explicit apply/rollback run that decided the row. */
  run_id: string | null
  state: ProposalState
  fingerprint: string
  created_at: string
  expires_at: string | null
  decided_at: string | null
  decided_by: string | null
  applied_at: string | null
  result: string | null
}

/** Fields required to enqueue a proposal; `id`/`state`/`created_at` are derived. */
export interface InsertProposalInput {
  project_id?: string | null
  source_thought_id: string
  item_kind: ProposalItemKind
  target_id?: string | null
  edge_type?: string | null
  lifecycle_action?: string | null
  direction?: string | null
  confidence: number
  rationale: string
  rule_id?: string | null
  payload: string
  fingerprint: string
  expires_at?: string | null
  run_id?: string | null
}

export interface ListProposalsOptions {
  state?: ProposalState
  project_id?: string
  /** Optional item-kind filter (ADR 2026-09-29 §2.7); a removed kind still filters. */
  item_kind?: StoredProposalItemKind
  /** Optional source-thought filter (queued proposals of one source thought). */
  source_thought_id?: string
  sourceThoughtId?: string
  /** Optional lower bound on created_at (ISO; inclusive). */
  created_after?: string
  createdAfter?: string
  limit?: number
}

export interface UpdateProposalStateInput {
  state: ProposalState
  decided_at?: string | null
  decided_by?: string | null
  applied_at?: string | null
  result?: string | null
  /** Run envelope; omitted leaves any existing `run_id` untouched. */
  run_id?: string | null
  /**
   * Refresh the staleness fingerprint; omitted leaves the stored value. Apply
   * rewrites it to the post-writer snapshot so rollback can detect later drift
   * (ADR 2026-09-29 §2.8).
   */
  fingerprint?: string | null
}

/**
 * Insert a `pending` proposal, or refresh the existing live row for the same
 * item (ADR §2.3 dedup). The partial unique index `idx_pp_dedup` collapses
 * repeated enqueues of the same item; re-enqueue refreshes `payload`,
 * `fingerprint` and `expires_at` instead of inserting a duplicate.
 */
export function insertProposal(db: Database, input: InsertProposalInput): PlacementProposalRow {
  const existing = findPendingByItem(db, input)
  if (existing) {
    db.prepare(
      `UPDATE placement_proposals
         SET payload = ?, fingerprint = ?, expires_at = ?, confidence = ?, rationale = ?, rule_id = ?, direction = ?
       WHERE id = ?`
    ).run(
      input.payload,
      input.fingerprint,
      input.expires_at ?? null,
      input.confidence,
      input.rationale,
      input.rule_id ?? null,
      input.direction ?? null,
      existing.id
    )
    return getProposal(db, existing.id) as PlacementProposalRow
  }

  const id = Bun.randomUUIDv7()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO placement_proposals (
      id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action,
      direction, confidence, rationale, rule_id, payload, state, fingerprint, created_at, expires_at, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id,
    input.project_id ?? null,
    input.source_thought_id,
    input.item_kind,
    input.target_id ?? null,
    input.edge_type ?? null,
    input.lifecycle_action ?? null,
    input.direction ?? null,
    input.confidence,
    input.rationale,
    input.rule_id ?? null,
    input.payload,
    input.fingerprint,
    now,
    input.expires_at ?? null,
    input.run_id ?? null
  )
  return getProposal(db, id) as PlacementProposalRow
}

export function getProposal(db: Database, id: string): PlacementProposalRow | undefined {
  const row = db.prepare('SELECT * FROM placement_proposals WHERE id = ?').get(id) as
    | PlacementProposalRow
    | undefined
  return row ?? undefined
}

/** List proposals, newest first; defaults to live `pending` rows (ADR §2.9). */
export function listProposals(db: Database, options: ListProposalsOptions = {}): PlacementProposalRow[] {
  const state = options.state ?? 'pending'
  const limit = Math.floor(options.limit ?? 100)
  const clauses = ['state = ?']
  const params: Array<string | number> = [state]
  if (options.project_id !== undefined) {
    clauses.push('project_id = ?')
    params.push(options.project_id)
  }
  if (options.item_kind !== undefined) {
    clauses.push('item_kind = ?')
    params.push(options.item_kind)
  }
  const sourceThoughtId = options.source_thought_id ?? options.sourceThoughtId
  if (sourceThoughtId !== undefined) {
    clauses.push('source_thought_id = ?')
    params.push(sourceThoughtId)
  }
  const createdAfter = options.created_after ?? options.createdAfter
  if (createdAfter !== undefined) {
    clauses.push('created_at >= ?')
    params.push(createdAfter)
  }
  params.push(limit)
  return db
    .prepare(`SELECT * FROM placement_proposals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as PlacementProposalRow[]
}

/** List every row of one run, newest first, across all states (ADR 2026-09-29 §2.2). */
export function listProposalsByRun(db: Database, runId: string): PlacementProposalRow[] {
  return db
    .prepare('SELECT * FROM placement_proposals WHERE run_id = ? ORDER BY created_at DESC')
    .all(runId) as PlacementProposalRow[]
}

/**
 * The rollback manifest of one run: its accepted rows in *reverse application
 * order* (ADR 2026-09-29 §2.8). Application order is `applied_at`, not
 * `created_at` — a row enqueued early can be applied late, so ordering by
 * creation would invert a run whose items were confirmed out of order. The
 * `created_at`/`id` tie-breakers keep the order total when two rows share an
 * `applied_at` (a caller-supplied `now`, or same-millisecond applies).
 */
export function listAcceptedProposalsByRun(db: Database, runId: string): PlacementProposalRow[] {
  return db
    .prepare(
      `SELECT * FROM placement_proposals
        WHERE run_id = ? AND state = 'accepted'
        ORDER BY applied_at DESC, created_at DESC, id DESC`
    )
    .all(runId) as PlacementProposalRow[]
}

/** Transition a proposal to a terminal state, recording the decision metadata. */
export function updateProposalState(
  db: Database,
  id: string,
  input: UpdateProposalStateInput
): PlacementProposalRow | undefined {
  const result = db
    .prepare(
      `UPDATE placement_proposals
         SET state = ?, decided_at = ?, decided_by = ?, applied_at = ?, result = ?, run_id = COALESCE(?, run_id), fingerprint = COALESCE(?, fingerprint)
       WHERE id = ?`
    )
    .run(
      input.state,
      input.decided_at ?? null,
      input.decided_by ?? null,
      input.applied_at ?? null,
      input.result ?? null,
      input.run_id ?? null,
      input.fingerprint ?? null,
      id
    )
  if (result.changes === 0) return undefined
  return getProposal(db, id)
}

/**
 * Delete terminal rows decided before `cutoff` and expire `pending` rows whose
 * `expires_at` has passed (ADR §2.4). Returns the number of rows removed.
 *
 * Expiring stamps `decided_at`: without it these rows were invisible to the
 * prune half of this very function (`decided_at IS NOT NULL`) and accumulated
 * forever. They are now decided-at-`now` and pruned one retention window later,
 * like every other terminal row.
 */
export function deleteExpired(db: Database, cutoff: string, now: string = new Date().toISOString()): number {
  const expired = db
    .prepare(
      `UPDATE placement_proposals SET state = 'expired', decided_at = ?
        WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .run(now, now).changes
  const pruned = db
    .prepare(`DELETE FROM placement_proposals WHERE state != 'pending' AND decided_at IS NOT NULL AND decided_at < ?`)
    .run(cutoff).changes
  return expired + pruned
}

/** Live (non-overdue) `pending` rows — the denominator of `maxPendingProposals`. */
export function countLivePendingProposals(db: Database, now: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM placement_proposals
        WHERE state = 'pending' AND (expires_at IS NULL OR expires_at > ?)`
    )
    .get(now) as { n: number }
  return row.n
}

/** The live row for the same item, if any — the dedup key of `idx_pp_dedup`. */
export function findPendingByItem(db: Database, input: InsertProposalInput): { id: string } | undefined {
  // `Statement.get` yields `null` for no match; normalise to `undefined` so
  // callers can test `=== undefined` (a bare `as` cast here made every
  // "is this a new item?" check silently report false).
  const row = db
    .prepare(
      `SELECT id FROM placement_proposals
        WHERE state = 'pending'
          AND source_thought_id = ?
          AND item_kind = ?
          AND COALESCE(target_id,'') = COALESCE(?,'')
          AND COALESCE(edge_type,'') = COALESCE(?,'')
          AND COALESCE(lifecycle_action,'') = COALESCE(?,'')`
    )
    .get(
      input.source_thought_id,
      input.item_kind,
      input.target_id ?? null,
      input.edge_type ?? null,
      input.lifecycle_action ?? null
    ) as { id: string } | null
  return row ?? undefined
}

/**
 * Drafts with no live/accepted triage row, newest first (ADR 2026-09-29 §2.3.3).
 * The `NOT EXISTS` clause is the backfill's idempotence key; the enqueue itself
 * is additionally deduped by `idx_pp_dedup`.
 */
export function findUntriagedDrafts(db: Database, limit: number): Thought[] {
  const rows = db
    .prepare(
      `SELECT t.id FROM thoughts t
        WHERE t.status = 'draft'
          AND COALESCE(t.is_cluster, 0) = 0
          AND COALESCE(t.is_profile, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM placement_proposals p
            WHERE p.source_thought_id = t.id
              AND p.item_kind IN ('triage_activate', 'triage_archive')
              AND p.state IN ('pending', 'accepted')
          )
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`
    )
    .all(Math.floor(limit)) as Array<{ id: string }>

  const drafts: Thought[] = []
  for (const row of rows) {
    const thought = getThoughtRow(db, row.id)
    if (thought) drafts.push(thought)
  }
  return drafts
}
