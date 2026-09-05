import { createEdge } from '../db/edges'
import { getDb } from '../db'
import { createThought, getThoughtsBatchWithTags, type Thought } from '../db/thoughts'
import { insertLog } from '../logging/log'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from './errors'
import { validateContentLength } from './thoughts.service'

export interface CreateClusterOptions {
  thoughtIds: string[]
  title?: string
  tags?: string[]
  source?: string
  projectId?: string
}

export interface CreateClusterResult {
  cluster: Thought
  edges: { source_id: string; target_id: string; type: string }[]
  members: Thought[]
}

export function createClusterService(options: CreateClusterOptions): CreateClusterResult {
  const { thoughtIds, title, tags, source, projectId } = options

  if (!thoughtIds || thoughtIds.length === 0) {
    throw new ValidationError('thought_ids is required')
  }

  const d = getDb()
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

  validateContentLength(content)

  const run = d.transaction(() => {
    const clusterThought = createThought(d, {
      content,
      tags: clusterTags,
      status: 'active',
      source,
      project_id: resolvedProjectId,
      is_cluster: true
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
