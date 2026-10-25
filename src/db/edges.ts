import type { Database } from 'bun:sqlite'
import { config } from '../config'
import {
  EdgeAlreadyExistsError,
  ClusterEdgeValidationError,
  SelfLoopEdgeError,
  EdgeConflictError,
  InvalidEdgeTypeError
} from './errors'
import { NotFoundError } from '../errors'
import { EDGE_TYPES, isValidEdgeType, SYMMETRIC_EDGE_TYPES, validateClusterConstraint, validateRetype } from './edge-validation'
import { boostImportance } from './importance'
import { getThoughtRow, getThoughtsBatchWithTags, type Thought } from './thoughts'
import { sqlIn, pairKey } from './utils'

export { EdgeAlreadyExistsError, ClusterEdgeValidationError, SelfLoopEdgeError, EdgeConflictError, InvalidEdgeTypeError }

// Validation rules (type vocabulary, retype checks, cluster constraints) live in
// the sibling module; re-exported here so every existing caller keeps importing
// them from `db/edges`.
export {
  EDGE_TYPES,
  type EdgeType,
  isValidEdgeType,
  SYMMETRIC_EDGE_TYPES,
  validateClusterConstraint,
  validateRetype
} from './edge-validation'

export interface Edge {
  id: string
  source_id: string
  target_id: string
  type: string
  created_at: string
}

export function createEdge(db: Database, sourceId: string, targetId: string, type: string = 'related'): Edge {
  if (!isValidEdgeType(type)) {
    throw new InvalidEdgeTypeError(type, [...EDGE_TYPES])
  }
  if (type === 'child') {
    throw new ClusterEdgeValidationError(
      "Edge type 'child' is deprecated. Use 'parent' instead — 'parent' covers both directions."
    )
  }
  if (sourceId === targetId) {
    throw new SelfLoopEdgeError()
  }
  validateClusterConstraint(db, sourceId, targetId, type)

  const existing = getEdgePairBetween(db, sourceId, targetId)
  if (existing) {
    if (existing.type === type) {
      if (SYMMETRIC_EDGE_TYPES.has(type)) return existing
      if (existing.source_id === sourceId && existing.target_id === targetId) {
        throw new EdgeAlreadyExistsError()
      }
      throw new EdgeConflictError(sourceId, targetId)
    }
    // `related` is the auto-link placeholder (lowest precedence). A caller
    // asking for a specific type replaces it instead of hitting a dead end,
    // since there is no edge-delete MCP tool.
    if (existing.type === 'related') {
      return upgradePlaceholderEdge(db, existing, sourceId, targetId, type)
    }
    throw new EdgeConflictError(sourceId, targetId)
  }

  return insertEdge(db, sourceId, targetId, type)
}

function insertEdge(db: Database, sourceId: string, targetId: string, type: string): Edge {
  const id = Bun.randomUUIDv7()
  const now = new Date().toISOString()

  let inserted = false
  const insertInTx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, type, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (min(source_id, target_id), max(source_id, target_id)) DO NOTHING
    `).run(id, sourceId, targetId, type, now)
    if (res.changes > 0) {
      inserted = true
      boostImportance(db, sourceId, 0.1)
    }
  })
  insertInTx()

  if (!inserted) {
    // Re-read the row that won the race / already existed.
    const existing = getEdgePairBetween(db, sourceId, targetId)
    if (existing) return existing
    throw new EdgeAlreadyExistsError()
  }

  return findEdge(db, id)
}

function insertEdgeRow(
  db: Database,
  id: string,
  sourceId: string,
  targetId: string,
  type: string,
  createdAt: string
): void {
  try {
    db.prepare(`
      INSERT INTO edges (id, source_id, target_id, type, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (min(source_id, target_id), max(source_id, target_id)) DO NOTHING
    `).run(id, sourceId, targetId, type, createdAt)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE')) throw new EdgeAlreadyExistsError()
    throw err
  }
}

/**
 * Transactionally replace an existing edge row with a fresh one of `type`,
 * preserving `createdAt`. Shared by the placeholder-upgrade path (a `related`
 * auto-link edge promoted to a specific type) and `retypeEdge` — both delete
 * the old row and insert a new id.
 */
function replaceEdge(
  db: Database,
  oldEdgeId: string,
  sourceId: string,
  targetId: string,
  type: string,
  createdAt: string
): Edge {
  const id = Bun.randomUUIDv7()

  const replaceInTx = db.transaction(() => {
    db.prepare('DELETE FROM edges WHERE id = ?').run(oldEdgeId)
    insertEdgeRow(db, id, sourceId, targetId, type, createdAt)
    boostImportance(db, sourceId, 0.1)
  })
  replaceInTx()

  return findEdge(db, id)
}

function upgradePlaceholderEdge(
  db: Database,
  placeholder: Edge,
  sourceId: string,
  targetId: string,
  type: string
): Edge {
  return replaceEdge(db, placeholder.id, sourceId, targetId, type, new Date().toISOString())
}

/**
 * Transactionally change an edge's type, preserving the original `created_at`.
 * Validates the new type and cluster constraints before committing.
 */
export function retypeEdge(db: Database, edgeId: string, newType: string): Edge {
  const edge = findEdge(db, edgeId)
  if (!edge) {
    throw new NotFoundError(`Edge not found: ${edgeId}`)
  }

  validateRetype(db, edge, newType)

  return replaceEdge(db, edge.id, edge.source_id, edge.target_id, newType, edge.created_at)
}

export function deleteEdge(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM edges WHERE id = ?').run(id)
  return result.changes > 0
}

export function getEdgesForThought(db: Database, id: string): Edge[] {
  return db
    .prepare(`
    SELECT * FROM edges WHERE source_id = ? OR target_id = ?
  `)
    .all(id, id) as Edge[]
}

/** Return the first `limit` edges touching a thought in stable order and their total count. */
export function getSourceEdgesForThoughtBounded(
  db: Database,
  id: string,
  limit: number
): { edges: Edge[]; count: number } {
  const count = db.prepare('SELECT COUNT(*) AS count FROM edges WHERE source_id = ? OR target_id = ?').get(id, id) as { count: number }
  const edges = db
    .prepare('SELECT * FROM edges WHERE source_id = ? OR target_id = ? ORDER BY id ASC LIMIT ?')
    .all(id, id, limit) as Edge[]
  return { edges, count: count.count }
}

export function getAllActiveEdges(db: Database): Edge[] {
  return db
    .prepare(`
    SELECT e.* FROM edges e
    INNER JOIN thoughts s ON e.source_id = s.id
    INNER JOIN thoughts t ON e.target_id = t.id
    WHERE s.status = 'active' AND t.status = 'active'
  `)
    .all() as Edge[]
}

export function findEdge(db: Database, id: string): Edge {
  return db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as Edge
}

/**
 * The (single) edge connecting `sourceId` and `targetId`, in either direction,
 * or `undefined` when the pair is not linked. Read-only counterpart of
 * {@link getEdgePairKeys} for a single pair.
 */
export function getEdgePairBetween(db: Database, sourceId: string, targetId: string): Edge | undefined {
  return db
    .prepare('SELECT * FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)')
    .get(sourceId, targetId, targetId, sourceId) as Edge | undefined
}

/**
 * Batched counterpart of {@link getEdgePairBetween}: returns canonical unordered
 * pair keys for every edge touching `thoughtIds`. Used by candidate detection to
 * skip pairs that are already linked without an N+1 query.
 */
export function getEdgePairKeys(db: Database, thoughtIds: string[]): Set<string> {
  if (thoughtIds.length === 0) return new Set()
  const ph = sqlIn(thoughtIds)
  const rows = db
    .prepare(`SELECT source_id, target_id FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`)
    .all(...thoughtIds, ...thoughtIds) as Array<{ source_id: string; target_id: string }>
  return new Set(rows.map(r => pairKey(r.source_id, r.target_id)))
}

/** Targets of `replaces` edges — thoughts superseded by a newer one. */
export function getReplacedTargetIds(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT target_id FROM edges WHERE type = 'replaces'`).all() as {
    target_id: string
  }[]
  return rows.map(r => r.target_id)
}

// --- Graph helpers ---

export interface EdgeView {
  id: string
  source: string
  target: string
  type: string
  created_at: string
}

export function toEdgeView(edge: Edge): EdgeView {
  return { id: edge.id, source: edge.source_id, target: edge.target_id, type: edge.type, created_at: edge.created_at }
}

interface ThoughtEdgeResult {
  thought: Thought
  upstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
  downstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
}

export function getThoughtEdges(
  db: Database,
  id: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  maxDegree: number = config.graph.maxDegree
): ThoughtEdgeResult | null {
  const thought = getThoughtRow(db, id)
  if (!thought) return null

  let rawEdges = getEdgesForThought(db, id)

  if (rawEdges.length > maxDegree) {
    rawEdges.sort((a, b) => b.created_at.localeCompare(a.created_at))
    rawEdges = rawEdges.slice(0, maxDegree)
  }

  const involvedIds = new Set<string>()
  for (const e of rawEdges) {
    if (e.source_id === id) involvedIds.add(e.target_id)
    if (e.target_id === id) involvedIds.add(e.source_id)
  }

  const thoughtMap = getThoughtsBatchWithTags(db, [...involvedIds])

  const upstream: ThoughtEdgeResult['upstream'] = []
  const downstream: ThoughtEdgeResult['downstream'] = []

  for (const raw of rawEdges) {
    const edge = toEdgeView(raw)
    if (raw.target_id === id && thoughtMap.has(raw.source_id)) {
      upstream.push({ edge, thought: thoughtMap.get(raw.source_id) })
    }
    if (raw.source_id === id && thoughtMap.has(raw.target_id)) {
      downstream.push({ edge, thought: thoughtMap.get(raw.target_id) })
    }
  }

  if (direction === 'upstream') return { thought, upstream, downstream: [] }
  if (direction === 'downstream') return { thought, upstream: [], downstream }
  return { thought, upstream, downstream }
}
