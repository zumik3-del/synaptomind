import type { Database } from 'bun:sqlite'
import { sqlIn } from './utils'

export interface OrphanEdge {
  id: string
  source_id: string
  target_id: string
  type: string
  missing_side: 'source' | 'target' | 'both'
}

export interface SelfLoopEdge {
  id: string
  source_id: string
  type: string
}

export interface DuplicateEdge {
  source_id: string
  target_id: string
  type: string
  count: number
}

export interface ClusterViolation {
  thought_id: string
  content: string
  edge_type: string
  other_id: string
}

export interface EmptyCluster {
  id: string
  content: string
}

export interface SingletonCluster {
  id: string
  content: string
  member_count: number
}

export interface OrphanedClusterMember {
  thought_id: string
  content: string
  cluster_edge_id: string
}

export interface ClusterlessDense {
  id: string
  content: string
  edge_count: number
}

export interface IslandThought {
  id: string
  content: string
  status: string
}

export interface OverlinkedThought {
  id: string
  content: string
  edge_count: number
}

export interface DuplicateContent {
  id_a: string
  id_b: string
  content_a: string
  content_b: string
  similarity: number
}

export interface TooShortThought {
  id: string
  content: string
  length: number
}

export interface TestRemnant {
  id: string
  content: string
}

export interface StaleDraft {
  id: string
  content: string
  created_at: string
  age_days: number
}

export interface UntaggedThought {
  id: string
  content: string
  status: string
}

export interface CircularChain {
  cycle: string[]
}

export interface BrokenParentChain {
  edge_id: string
  source_id: string
  target_id: string
  target_status: string
}

export interface ReplacesChain {
  chain: string[]
}

export interface MissingEmbedding {
  id: string
  content: string
}

export interface DeadPrimer {
  thought_id: string
  content: string
  hit_count: number
}

export interface ImportanceOutlier {
  id: string
  content: string
  importance: number
  direction: 'low' | 'high'
}

export function findOrphanEdges(db: Database): OrphanEdge[] {
  const rows = db.prepare(`
    SELECT e.id, e.source_id, e.target_id, e.type,
      CASE
        WHEN t1.id IS NULL AND t2.id IS NULL THEN 'both'
        WHEN t1.id IS NULL THEN 'source'
        ELSE 'target'
      END AS missing_side
    FROM edges e
    LEFT JOIN thoughts t1 ON e.source_id = t1.id
    LEFT JOIN thoughts t2 ON e.target_id = t2.id
    WHERE t1.id IS NULL OR t2.id IS NULL
  `).all() as OrphanEdge[]
  return rows
}

export function findSelfLoopEdges(db: Database): SelfLoopEdge[] {
  return db.prepare(`
    SELECT id, source_id, type FROM edges WHERE source_id = target_id
  `).all() as SelfLoopEdge[]
}

export function findDuplicateEdges(db: Database): DuplicateEdge[] {
  return db.prepare(`
    SELECT source_id, target_id, type, COUNT(*) as count
    FROM edges GROUP BY source_id, target_id, type HAVING count > 1
  `).all() as DuplicateEdge[]
}

export function findClusterViolations(db: Database): ClusterViolation[] {
  return db.prepare(`
    SELECT DISTINCT
      t.id AS thought_id, t.content, e.type AS edge_type,
      CASE WHEN e.source_id = t.id THEN e.target_id ELSE e.source_id END AS other_id
    FROM thoughts t
    JOIN edges e ON (e.source_id = t.id OR e.target_id = t.id)
    JOIN thoughts o ON o.id = CASE WHEN e.source_id = t.id THEN e.target_id ELSE e.source_id END
    WHERE t.is_cluster = 0
      AND (
        (e.type = 'cluster')
        OR (e.type = 'references' AND o.is_cluster = 1)
      )
  `).all() as ClusterViolation[]
}

export function findEmptyClusters(db: Database): EmptyCluster[] {
  return db.prepare(`
    SELECT t.id, t.content FROM thoughts t
    WHERE t.is_cluster = 1
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.source_id = t.id AND e.type = 'cluster'
      )
  `).all() as EmptyCluster[]
}

export function findSingletonClusters(db: Database): SingletonCluster[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS member_count
    FROM thoughts t
    LEFT JOIN edges e ON e.source_id = t.id AND e.type = 'cluster'
    WHERE t.is_cluster = 1
    GROUP BY t.id
    HAVING member_count <= 1
  `).all() as SingletonCluster[]
}

export function findOrphanedClusterMembers(db: Database): OrphanedClusterMember[] {
  return db.prepare(`
    SELECT e.target_id AS thought_id, t.content, e.id AS cluster_edge_id
    FROM edges e
    JOIN thoughts t ON t.id = e.target_id
    WHERE e.type = 'cluster'
      AND NOT EXISTS (
        SELECT 1 FROM thoughts c WHERE c.id = e.source_id AND c.is_cluster = 1
      )
  `).all() as OrphanedClusterMember[]
}

export function findClusterlessDense(db: Database, minEdges: number = 5): ClusterlessDense[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS edge_count
    FROM thoughts t
    JOIN edges e ON (e.source_id = t.id OR e.target_id = t.id)
      AND e.type = 'related'
    WHERE t.is_cluster = 0
      AND t.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM edges ce
        WHERE (ce.source_id = t.id OR ce.target_id = t.id)
          AND ce.type = 'cluster'
      )
    GROUP BY t.id
    HAVING edge_count >= ?
  `).all(minEdges) as ClusterlessDense[]
}

export function findIslandThoughts(db: Database): IslandThought[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status FROM thoughts t
    WHERE t.status = 'active'
      AND t.is_cluster = 0
      AND t.is_profile = 0
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.source_id = t.id OR e.target_id = t.id
      )
  `).all() as IslandThought[]
}

export function findOverlinkedThoughts(db: Database, maxEdges: number = 10): OverlinkedThought[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS edge_count
    FROM thoughts t
    JOIN edges e ON (e.source_id = t.id OR e.target_id = t.id)
    WHERE t.is_cluster = 0
    GROUP BY t.id
    HAVING edge_count > ?
  `).all(maxEdges) as OverlinkedThought[]
}

export function findDuplicateContent(db: Database): DuplicateContent[] {
  const rows = db.prepare(`
    SELECT a.id AS id_a, b.id AS id_b, a.content AS content_a, b.content AS content_b
    FROM thoughts a
    JOIN thoughts b ON a.id < b.id
      AND a.content = b.content
      AND length(a.content) > 10
  `).all() as Array<{ id_a: string; id_b: string; content_a: string; content_b: string }>
  return rows.map(r => ({ ...r, similarity: 1.0 }))
}

export function findTooShort(db: Database, minLength: number = 10): TooShortThought[] {
  return db.prepare(`
    SELECT id, content, length(content) AS length FROM thoughts
    WHERE length(content) < ? AND is_cluster = 0
  `).all(minLength) as TooShortThought[]
}

export function findTestRemnants(db: Database): TestRemnant[] {
  return db.prepare(`
    SELECT id, content FROM thoughts
    WHERE is_cluster = 0
      AND (
        content GLOB '*[Tt]est*[Tt]hought*'
        OR content = 'Hello from SynaptoMind!'
        OR content LIKE 'Test %'
        OR content LIKE 'test %'
      )
  `).all() as TestRemnant[]
}

export function findStaleDrafts(db: Database, days: number = 30): StaleDraft[] {
  return db.prepare(`
    SELECT id, content, created_at,
      CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days
    FROM thoughts
    WHERE status = 'draft'
      AND is_cluster = 0
      AND julianday('now') - julianday(created_at) > ?
    ORDER BY created_at ASC
  `).all(days) as StaleDraft[]
}

export function findUntagged(db: Database): UntaggedThought[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status FROM thoughts t
    WHERE t.status = 'active'
      AND t.is_cluster = 0
      AND NOT EXISTS (
        SELECT 1 FROM thought_tags tt WHERE tt.thought_id = t.id
      )
  `).all() as UntaggedThought[]
}

export function findCircularChains(db: Database): CircularChain[] {
  const edges = db.prepare(`
    SELECT source_id, target_id FROM edges
    WHERE type IN ('parent', 'develops')
  `).all() as Array<{ source_id: string; target_id: string }>

  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!adj.has(e.source_id)) adj.set(e.source_id, [])
    adj.get(e.source_id)!.push(e.target_id)
  }

  const cycles: string[][] = []
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const path: string[] = []

  function dfs(node: string) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node)
      if (cycleStart >= 0) cycles.push(path.slice(cycleStart))
      return
    }
    if (visited.has(node)) return
    visited.add(node)
    inStack.add(node)
    path.push(node)
    for (const next of adj.get(node) || []) dfs(next)
    path.pop()
    inStack.delete(node)
  }

  for (const node of adj.keys()) dfs(node)
  return cycles.map(c => ({ cycle: c }))
}

export function findBrokenParentChains(db: Database): BrokenParentChain[] {
  return db.prepare(`
    SELECT e.id AS edge_id, e.source_id, e.target_id, t.status AS target_status
    FROM edges e
    JOIN thoughts t ON t.id = e.target_id
    WHERE e.type IN ('parent', 'develops')
      AND t.status IN ('archived', 'draft')
  `).all() as BrokenParentChain[]
}

export function findReplacesChains(db: Database): ReplacesChain[] {
  const edges = db.prepare(`
    SELECT source_id, target_id FROM edges WHERE type = 'replaces'
  `).all() as Array<{ source_id: string; target_id: string }>

  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!adj.has(e.source_id)) adj.set(e.source_id, [])
    adj.get(e.source_id)!.push(e.target_id)
  }

  const chains: string[][] = []
  const visited = new Set<string>()

  function dfs(node: string, path: string[]) {
    const neighbors = adj.get(node) || []
    if (neighbors.length === 0) {
      if (path.length > 1) chains.push([...path])
      return
    }
    for (const next of neighbors) {
      if (visited.has(next)) continue
      visited.add(next)
      path.push(next)
      dfs(next, path)
      path.pop()
    }
  }

  for (const [node] of adj) {
    if (!visited.has(node)) {
      visited.add(node)
      dfs(node, [node])
    }
  }
  return chains.map(c => ({ chain: c }))
}

export function findMissingEmbeddings(db: Database): MissingEmbedding[] {
  try {
    return db.prepare(`
      SELECT t.id, t.content FROM thoughts t
      WHERE t.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM vec_thoughts v WHERE v.id = t.id
        )
    `).all() as MissingEmbedding[]
  } catch {
    return []
  }
}

export function findDeadPrimers(db: Database, _days: number = 30): DeadPrimer[] {
  return db.prepare(`
    SELECT p.thought_id, t.content, COALESCE(p.hit_count, 0) AS hit_count
    FROM primers p
    JOIN thoughts t ON t.id = p.thought_id
    WHERE COALESCE(p.hit_count, 0) = 0
  `).all() as DeadPrimer[]
}

export function findImportanceOutliers(db: Database): ImportanceOutlier[] {
  return db.prepare(`
    SELECT t.id, t.content, i.importance,
      CASE WHEN i.importance < 0.1 THEN 'low' ELSE 'high' END AS direction
    FROM thought_importance i
    JOIN thoughts t ON t.id = i.thought_id
    WHERE i.importance < 0.1 OR i.importance > 10
  `).all() as ImportanceOutlier[]
}

export function getGraphStats(db: Database): { total_thoughts: number; total_edges: number; total_clusters: number; active: number; draft: number; archived: number } {
  const thoughts = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts`).get() as { cnt: number }
  const edges = db.prepare(`SELECT COUNT(*) AS cnt FROM edges`).get() as { cnt: number }
  const clusters = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE is_cluster = 1`).get() as { cnt: number }
  const active = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE status = 'active' AND is_cluster = 0`).get() as { cnt: number }
  const draft = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE status = 'draft' AND is_cluster = 0`).get() as { cnt: number }
  const archived = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE status = 'archived' AND is_cluster = 0`).get() as { cnt: number }
  return {
    total_thoughts: thoughts.cnt,
    total_edges: edges.cnt,
    total_clusters: clusters.cnt,
    active: active.cnt,
    draft: draft.cnt,
    archived: archived.cnt
  }
}

export function deleteEdges(db: Database, edgeIds: string[]): number {
  if (edgeIds.length === 0) return 0
  const ph = sqlIn(edgeIds)
  const result = db.prepare(`DELETE FROM edges WHERE id IN (${ph})`).run(...edgeIds)
  return result.changes
}

export function deleteThoughts(db: Database, thoughtIds: string[]): number {
  if (thoughtIds.length === 0) return 0
  const ph = sqlIn(thoughtIds)
  const result = db.prepare(`DELETE FROM thoughts WHERE id IN (${ph})`).run(...thoughtIds)
  return result.changes
}
