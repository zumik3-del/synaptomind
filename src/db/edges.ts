import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { EdgeAlreadyExistsError } from './errors'
import { NotFoundError } from './errors'
import { validateRetype } from './edge-validation'
import { boostImportance } from './importance'
import { getThoughtRow, getThoughtsBatchWithTags, type Thought } from './thoughts'
import { sqlIn, pairKey } from './utils'

export {
  EdgeAlreadyExistsError,
  ClusterEdgeValidationError,
  SelfLoopEdgeError,
  EdgeConflictError,
  InvalidEdgeTypeError
} from './errors'

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

function insertEdgeSql(
  db: Database,
  id: string,
  sourceId: string,
  targetId: string,
  type: string,
  createdAt: string
): number {
  const res = db
    .prepare(`
    INSERT INTO edges (id, source_id, target_id, type, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (min(source_id, target_id), max(source_id, target_id)) DO NOTHING
  `)
    .run(id, sourceId, targetId, type, createdAt)
  return res.changes
}

export function insertEdgeRow(
  db: Database,
  sourceId: string,
  targetId: string,
  type: string
): { id: string; inserted: boolean } {
  const id = Bun.randomUUIDv7()
  const changes = insertEdgeSql(db, id, sourceId, targetId, type, new Date().toISOString())
  return { id, inserted: changes > 0 }
}

function insertEdgeRowStrict(
  db: Database,
  id: string,
  sourceId: string,
  targetId: string,
  type: string,
  createdAt: string
): void {
  try {
    insertEdgeSql(db, id, sourceId, targetId, type, createdAt)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE')) throw new EdgeAlreadyExistsError()
    throw err
  }
}

export function replaceEdgeRow(
  db: Database,
  oldEdgeId: string,
  sourceId: string,
  targetId: string,
  type: string,
  createdAt: string
): string {
  const id = Bun.randomUUIDv7()
  db.prepare('DELETE FROM edges WHERE id = ?').run(oldEdgeId)
  insertEdgeRowStrict(db, id, sourceId, targetId, type, createdAt)
  return id
}

export function retypeEdge(db: Database, edgeId: string, newType: string): Edge {
  const edge = findEdge(db, edgeId)
  if (!edge) {
    throw new NotFoundError(`Edge not found: ${edgeId}`)
  }

  validateRetype(db, edge, newType)

  let id = ''
  const replaceInTx = db.transaction(() => {
    id = replaceEdgeRow(db, edge.id, edge.source_id, edge.target_id, newType, edge.created_at)
    boostImportance(db, edge.source_id, 0.1)
  })
  replaceInTx()

  return findEdge(db, id)
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

export function getSourceEdgesForThoughtBounded(
  db: Database,
  id: string,
  limit: number
): { edges: Edge[]; count: number } {
  const count = db
    .prepare('SELECT COUNT(*) AS count FROM edges WHERE source_id = ? OR target_id = ?')
    .get(id, id) as { count: number }
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

export function getEdgePairBetween(
  db: Database,
  sourceId: string,
  targetId: string
): Edge | undefined {
  return db
    .prepare(
      'SELECT * FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)'
    )
    .get(sourceId, targetId, targetId, sourceId) as Edge | undefined
}

export function getEdgePairKeys(db: Database, thoughtIds: string[]): Set<string> {
  if (thoughtIds.length === 0) return new Set()
  const ph = sqlIn(thoughtIds)
  const rows = db
    .prepare(
      `SELECT source_id, target_id FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`
    )
    .all(...thoughtIds, ...thoughtIds) as Array<{ source_id: string; target_id: string }>
  return new Set(rows.map(r => pairKey(r.source_id, r.target_id)))
}

export function getReplacedTargetIds(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT target_id FROM edges WHERE type = 'replaces'`).all() as {
    target_id: string
  }[]
  return rows.map(r => r.target_id)
}

export interface EdgeView {
  id: string
  source: string
  target: string
  type: string
  created_at: string
}

export function toEdgeView(edge: Edge): EdgeView {
  return {
    id: edge.id,
    source: edge.source_id,
    target: edge.target_id,
    type: edge.type,
    created_at: edge.created_at
  }
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
