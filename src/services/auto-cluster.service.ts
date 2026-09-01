import { config } from '../config'
import { getDb } from '../db'
import { searchThoughts } from '../db/search'
import { type ClusterCandidate, listClusterCandidates } from '../db/thoughts'
import { generateEmbeddings } from '../embedder/client'
import { insertLog } from '../logging/log'
import { createClusterService } from './cluster.service'
import { recordJobRun, getLastJobRun } from './utils'
import type { Database } from 'bun:sqlite'

export interface AutoClusterOptions {
  minAgeDays?: number
  minSimilarity?: number
  minMembers?: number
  dryRun?: boolean
}

export interface AutoClusterGroup {
  members: string[]
  title: string
}

export interface AutoClusterResult {
  dry_run: boolean
  candidates: number
  groups: AutoClusterGroup[]
  clusters_created: number
}

/** Neighbor lookup used to build the proximity graph. Injected for tests. */
export interface AutoClusterDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: (
    candidateId: string,
    embedding: Float32Array,
    topK: number
  ) => Array<{ id: string; distance: number }>
}

/** Title heuristic: first 3 words of the newest thought's content (issue #196). */
export function generateClusterTitle(thoughts: { content: string; created_at: string }[]): string {
  const newest = thoughts.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
  const words = newest.content.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 3).join(' ')
}

/** Union-Find connected components from a list of undirected pairs. */
export function findComponents(pairs: Array<[string, string]>, allIds: string[]): string[][] {
  const parent = new Map<string, string>()
  for (const id of allIds) parent.set(id, id)

  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    while (parent.get(x) !== root) {
      const next = parent.get(x) as string
      parent.set(x, root)
      x = next
    }
    return root
  }

  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const [a, b] of pairs) union(a, b)

  const groups = new Map<string, string[]>()
  for (const id of allIds) {
    const root = find(id)
    const arr = groups.get(root) ?? []
    arr.push(id)
    groups.set(root, arr)
  }
  return [...groups.values()]
}

/** Group candidates into clusters by proximity. Neighbor set is injected. */
export function groupCandidates(
  candidates: ClusterCandidate[],
  neighborFn: (thoughtId: string) => string[],
  minMembers: number
): string[][] {
  const idSet = new Set(candidates.map(c => c.id))
  const pairs: Array<[string, string]> = []
  for (const c of candidates) {
    for (const n of neighborFn(c.id)) {
      if (n === c.id || !idSet.has(n)) continue
      pairs.push([c.id, n])
    }
  }
  return findComponents(
    pairs,
    candidates.map(c => c.id)
  ).filter(g => g.length >= minMembers)
}

const defaultSearchNeighbors: NonNullable<AutoClusterDeps['searchNeighbors']> = (_candidateId, embedding, topK) => {
  const db = getDb()
  const results = searchThoughts(db, { embedding, topK, clusterFilter: 'exclude' })
  return results.map(r => ({ id: r.thought.id, distance: r.distance }))
}

function recordRun(result: AutoClusterResult, db: Database): void {
  recordJobRun(db, 'last_auto_cluster', result)
}

export function getLastAutoClusterStatus(): { last_run: string | null; result: AutoClusterResult | null } {
  return getLastJobRun<AutoClusterResult>(getDb(), 'last_auto_cluster')
}

/**
 * Batch auto-clustering (issue #196). Candidates are draft/active thoughts older
 * than minAgeDays without cluster edges; groups are connected components of
 * thoughts whose embeddings are within minSimilarity (distance); each group with
 * >= minMembers members becomes a cluster (source='auto_cluster'). dryRun only
 * computes groups without creating anything.
 */
export async function runAutoClusterJob(
  options: AutoClusterOptions = {},
  deps: AutoClusterDeps = {}
): Promise<AutoClusterResult> {
  const d = getDb()
  const minAgeDays = options.minAgeDays ?? config.autoCluster.minAgeDays
  const minSimilarity = options.minSimilarity ?? config.autoCluster.minSimilarity
  const minMembers = options.minMembers ?? config.autoCluster.minMembers
  const dryRun = options.dryRun ?? config.autoCluster.dryRun

  const embed = deps.embed ?? generateEmbeddings
  const searchNeighbors = deps.searchNeighbors ?? defaultSearchNeighbors

  const candidates = listClusterCandidates(d, minAgeDays)
  if (candidates.length === 0) {
    const empty: AutoClusterResult = { dry_run: dryRun, candidates: 0, groups: [], clusters_created: 0 }
    recordRun(empty, d)
    return empty
  }

  const embeddings = await embed(candidates.map(c => c.content))

  const neighborFn = (thoughtId: string): string[] => {
    const idx = candidates.findIndex(c => c.id === thoughtId)
    if (idx === -1) return []
    const results = searchNeighbors(thoughtId, embeddings[idx], Math.max(minMembers, candidates.length))
    return results.filter(r => r.distance < minSimilarity).map(r => r.id)
  }

  const groups = groupCandidates(candidates, neighborFn, minMembers)

  const clusterGroups: AutoClusterGroup[] = []
  let created = 0
  for (const group of groups) {
    const members = group
      .map(id => candidates.find(c => c.id === id))
      .filter((c): c is ClusterCandidate => Boolean(c))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    const title = generateClusterTitle(members)
    clusterGroups.push({ members: members.map(m => m.id), title })
    if (!dryRun) {
      createClusterService({
        thoughtIds: members.map(m => m.id),
        title,
        source: 'auto_cluster',
        tags: ['auto']
      })
      created += 1
    }
  }

  const result: AutoClusterResult = {
    dry_run: dryRun,
    candidates: candidates.length,
    groups: clusterGroups,
    clusters_created: created
  }
  recordRun(result, d)
  insertLog(
    'info',
    'auto_cluster',
    `Auto-cluster run: ${candidates.length} candidates, ${clusterGroups.length} groups`,
    {
      dry_run: dryRun,
      clusters_created: created
    }
  )
  return result
}
