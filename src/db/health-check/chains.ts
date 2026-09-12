import type { Database } from 'bun:sqlite'
import type { BrokenParentChain, CircularChain, ReplacesChain } from './types'

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
    JOIN thoughts s ON s.id = e.source_id
    WHERE e.type IN ('parent', 'develops')
      AND t.status IN ('archived', 'draft')
      AND s.status != 'archived'
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
      // A chain needs >= 2 replaces edges, i.e. >= 3 nodes. A single edge
      // (path length 2) is a plain replacement, not a chain.
      if (path.length > 2) chains.push([...path])
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
