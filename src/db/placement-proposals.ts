import type { Database } from 'bun:sqlite'

/** Item classes a placement plan maps to (ADR §2.1). */
export type ProposalItemKind = 'edge' | 'placement' | 'lifecycle'

/** Queue lifecycle: `pending` is live, every other state is terminal (ADR §2.2). */
export type ProposalState = 'pending' | 'accepted' | 'rejected' | 'expired' | 'stale'

export interface PlacementProposalRow {
  id: string
  project_id: string | null
  source_thought_id: string
  item_kind: ProposalItemKind
  target_id: string | null
  edge_type: string | null
  lifecycle_action: string | null
  direction: string | null
  confidence: number
  rationale: string
  rule_id: string | null
  payload: string
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
}

export interface ListProposalsOptions {
  state?: ProposalState
  project_id?: string
  limit?: number
}

export interface UpdateProposalStateInput {
  state: ProposalState
  decided_at?: string | null
  decided_by?: string | null
  applied_at?: string | null
  result?: string | null
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
      direction, confidence, rationale, rule_id, payload, state, fingerprint, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
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
    input.expires_at ?? null
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
  params.push(limit)
  return db
    .prepare(`SELECT * FROM placement_proposals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as PlacementProposalRow[]
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
         SET state = ?, decided_at = ?, decided_by = ?, applied_at = ?, result = ?
       WHERE id = ?`
    )
    .run(
      input.state,
      input.decided_at ?? null,
      input.decided_by ?? null,
      input.applied_at ?? null,
      input.result ?? null,
      id
    )
  if (result.changes === 0) return undefined
  return getProposal(db, id)
}

/**
 * Delete terminal rows decided before `cutoff` and expire `pending` rows whose
 * `expires_at` has passed (ADR §2.4). Returns the number of rows removed.
 */
export function deleteExpired(db: Database, cutoff: string, now: string = new Date().toISOString()): number {
  const expired = db
    .prepare(`UPDATE placement_proposals SET state = 'expired' WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`)
    .run(now).changes
  const pruned = db
    .prepare(`DELETE FROM placement_proposals WHERE state != 'pending' AND decided_at IS NOT NULL AND decided_at < ?`)
    .run(cutoff).changes
  return expired + pruned
}

/** The live row for the same item, if any — the dedup key of `idx_pp_dedup`. */
function findPendingByItem(db: Database, input: InsertProposalInput): { id: string } | undefined {
  return db
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
    ) as { id: string } | undefined
}
