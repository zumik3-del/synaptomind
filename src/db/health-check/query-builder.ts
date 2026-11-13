import type { EdgeType } from '../edges'
import type { ThoughtStatus } from '../../types/thought'

export const THOUGHTS = 'thoughts t'

export function regularThoughtsWhere(status?: ThoughtStatus): string {
  return status === undefined ? 't.is_cluster = 0' : `t.is_cluster = 0 AND t.status = '${status}'`
}

function edgeEndpoint(side: 'source' | 'target', thoughtAlias: string): string {
  return `e.${side}_id = ${thoughtAlias}.id`
}

function eitherEndpoint(thoughtAlias: string): string {
  return `(${edgeEndpoint('source', thoughtAlias)} OR ${edgeEndpoint('target', thoughtAlias)})`
}

function incidentOn(opts?: { sourceOnly?: boolean; type?: EdgeType }): string {
  const side = opts?.sourceOnly ? edgeEndpoint('source', 't') : eitherEndpoint('t')
  const type = opts?.type ? ` AND e.type = '${opts.type}'` : ''
  return `${side}${type}`
}

export function noIncidentEdges(opts?: { sourceOnly?: boolean; type?: EdgeType }): string {
  return `NOT EXISTS (SELECT 1 FROM edges e WHERE ${incidentOn(opts)})`
}

export function joinIncidentEdges(opts?: {
  left?: boolean
  sourceOnly?: boolean
  type?: EdgeType
}): string {
  return `${opts?.left ? 'LEFT ' : ''}JOIN edges e ON ${incidentOn(opts)}`
}

export function joinEdgeEndpoint(
  side: 'source' | 'target',
  thoughtAlias: string,
  left = false
): string {
  return `${left ? 'LEFT ' : ''}JOIN thoughts ${thoughtAlias} ON ${edgeEndpoint(side, thoughtAlias)}`
}
