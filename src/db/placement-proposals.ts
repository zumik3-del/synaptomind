import type { Database } from 'bun:sqlite'

export type ProposalItemKind = 'edge'

export type LegacyProposalItemKind =
  | 'placement'
  | 'lifecycle'
  | 'triage_activate'
  | 'triage_archive'

export type StoredProposalItemKind = ProposalItemKind | LegacyProposalItemKind

export function isLegacyItemKind(kind: string): kind is LegacyProposalItemKind {
  return (
    kind === 'placement' ||
    kind === 'lifecycle' ||
    kind === 'triage_activate' ||
    kind === 'triage_archive'
  )
}

export type ProposalState =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'rolled_back'

export interface PlacementProposalRow {
  id: string
  project_id: string | null
  source_thought_id: string
  item_kind: StoredProposalItemKind
  target_id: string | null
  edge_type: string | null
  lifecycle_action: string | null
  direction: string | null
  confidence: number
  rationale: string
  rule_id: string | null
  payload: string
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
  item_kind?: StoredProposalItemKind
  source_thought_id?: string
  sourceThoughtId?: string
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
  run_id?: string | null
  fingerprint?: string | null
}

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

export function listProposals(
  db: Database,
  options: ListProposalsOptions = {}
): PlacementProposalRow[] {
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
    .prepare(
      `SELECT * FROM placement_proposals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params) as PlacementProposalRow[]
}

// Ordering by `applied_at` (not `created_at`) is what makes a rollback invert the run: an item
// enqueued early can be applied late, and the id tie-breaker keeps the order total.
export function listAcceptedProposalsByRun(db: Database, runId: string): PlacementProposalRow[] {
  return db
    .prepare(
      `SELECT * FROM placement_proposals
        WHERE run_id = ? AND state = 'accepted'
        ORDER BY applied_at DESC, created_at DESC, id DESC`
    )
    .all(runId) as PlacementProposalRow[]
}

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

// Expiry must stamp `decided_at`, or these rows stay invisible to the prune below and accumulate forever.
export function deleteExpired(
  db: Database,
  cutoff: string,
  now: string = new Date().toISOString()
): number {
  const expired = db
    .prepare(
      `UPDATE placement_proposals SET state = 'expired', decided_at = ?
        WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .run(now, now).changes
  const pruned = db
    .prepare(
      `DELETE FROM placement_proposals WHERE state != 'pending' AND decided_at IS NOT NULL AND decided_at < ?`
    )
    .run(cutoff).changes
  return expired + pruned
}

function findPendingByItem(db: Database, input: InsertProposalInput): { id: string } | undefined {
  // `Statement.get` yields `null`, not `undefined`; a bare cast here made every "new item?" check false.
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
