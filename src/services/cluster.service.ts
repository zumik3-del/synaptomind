import type { Database } from 'bun:sqlite'
import { createEdge, deleteEdge, deleteClusterEdges, findClusterMemberEdge, getClusterMembers, getClusterThought } from '../db/edges'
import { getDb } from '../db'
import { getThoughtLimitsDB } from '../db/settings'
import { createThought, deleteThought, getThoughtRow, getThoughtsBatchWithTags, type Thought } from '../db/thoughts'
import { insertLog } from '../logging/log'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from '../errors'
import { validateContentLength } from '../validation'

interface CreateClusterOptions {
  thoughtIds: string[]
  title?: string
  tags?: string[]
  source?: string
  projectId?: string
}

interface CreateClusterResult {
  cluster: Thought
  edges: { source_id: string; target_id: string; type: string }[]
  members: Thought[]
}

export function createClusterService(options: CreateClusterOptions, d: Database = getDb()): CreateClusterResult {
  const { thoughtIds, title, tags, source, projectId } = options

  if (!thoughtIds || thoughtIds.length === 0) {
    throw new ValidationError('thought_ids is required')
  }

  const memberMap = getThoughtsBatchWithTags(d, thoughtIds)
  const members = thoughtIds.map(id => memberMap.get(id)).filter(Boolean) as Thought[]
  if (members.length !== thoughtIds.length) {
    const missing = thoughtIds.filter(id => !memberMap.has(id))
    throw new NotFoundError(`Thoughts not found: ${missing.join(', ')}`)
  }

  let resolvedProjectId = projectId
  if (!resolvedProjectId) {
    const memberProjects = new Set(members.map(m => m.project_id))
    if (memberProjects.size === 1) {
      resolvedProjectId = memberProjects.values().next().value
    }
  }

  const content = title || `Cluster of ${thoughtIds.length} thoughts`
  const clusterTags = ['cluster', ...(tags || [])]

  validateContentLength(content, getThoughtLimitsDB(d))

  const run = d.transaction(() => {
    const clusterThought = createThought(d, {
      content,
      tags: clusterTags,
      status: 'active',
      source,
      project_id: resolvedProjectId,
      is_cluster: true,
      // Clusters are synthetic containers, not content — protection is
      // exceptional (ADR §4) so cluster_dissolve stays reachable end-to-end.
      // A cluster protected explicitly (memory_store action=update
      // is_protected=true) is still refused by dissolve.
      is_protected: false
    })

    const createdEdges: { source_id: string; target_id: string; type: string }[] = []
    for (const memberId of thoughtIds) {
      try {
        createEdge(d, clusterThought.id, memberId, 'cluster')
        createdEdges.push({ source_id: clusterThought.id, target_id: memberId, type: 'cluster' })
      } catch (err: unknown) {
        if (err instanceof EdgeAlreadyExistsError) {
          insertLog('warning', 'cluster', `Edge to member ${memberId} already exists — skipped`, {
            cluster_id: clusterThought.id,
            member_id: memberId
          })
        } else {
          throw err
        }
      }
    }

    return { cluster: clusterThought, edges: createdEdges, members }
  })
  return run()
}

// --- Cluster membership management ---

interface RemoveClusterMemberOptions {
  clusterId: string
  thoughtId: string
}

interface RemoveClusterMemberResult {
  clusterId: string
  thoughtId: string
  edgeId: string
}

export function removeClusterMemberService(options: RemoveClusterMemberOptions, d: Database = getDb()): RemoveClusterMemberResult {
  const { clusterId, thoughtId } = options

  const cluster = getClusterThought(d, clusterId)
  if (!cluster) {
    throw new NotFoundError(`Cluster not found: ${clusterId}`)
  }

  const edge = findClusterMemberEdge(d, clusterId, thoughtId)

  if (!edge) {
    throw new NotFoundError(`Thought ${thoughtId} is not a member of cluster ${clusterId}`)
  }

  deleteEdge(d, edge.id)

  return { clusterId, thoughtId, edgeId: edge.id }
}

// --- Cluster dissolution ---

interface DissolveClusterOptions {
  clusterId: string
}

interface DissolveClusterResult {
  clusterId: string
  deletedEdgeCount: number
}

export function dissolveClusterService(options: DissolveClusterOptions, d: Database = getDb()): DissolveClusterResult {
  const { clusterId } = options

  const cluster = getThoughtRow(d, clusterId)
  if (!cluster?.is_cluster) {
    throw new NotFoundError(`Cluster not found: ${clusterId}`)
  }

  if (cluster.is_protected) {
    throw new ValidationError(`Cluster ${clusterId} is protected and cannot be dissolved`)
  }

  let deletedEdgeCount = 0
  const run = d.transaction(() => {
    deletedEdgeCount = deleteClusterEdges(d, clusterId)
    deleteThought(d, clusterId)
  })
  run()

  return { clusterId, deletedEdgeCount }
}

// --- Service wrappers for tool layer (thin-tools guard) ---

export function getClusterThoughtService(clusterId: string, d: Database = getDb()): { id: string; content: string } | undefined {
  return getClusterThought(d, clusterId)
}

export function listClusterMembersService(clusterId: string, d: Database = getDb()): Thought[] {
  return getClusterMembers(d, clusterId)
}

/** Find the cluster edge ID for a specific member, or undefined if not a member. */
export function findClusterMemberEdgeService(clusterId: string, thoughtId: string, d: Database = getDb()): string | undefined {
  return findClusterMemberEdge(d, clusterId, thoughtId)?.id
}
