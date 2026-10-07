import type { EdgeType } from '../edges'
import type { ThoughtStatus } from '../../types/thought'

/**
 * Shared SQL fragments for the health-check finders.
 *
 * The finders in edges/clusters/content repeat the same relational
 * constructions — binding an edge endpoint to its thought row, the
 * "thought has no incident edge" existence check, the regular-thoughts
 * filter. Each pattern is written here once and composed by the finders;
 * query semantics are unchanged. Fragments assume the canonical aliases
 * `t` (thoughts) and `e` (edges); {@link joinEdgeEndpoint} takes the
 * thought alias explicitly because the edge-driven finders join both
 * endpoints under different aliases.
 */

/** FROM clause binding the thoughts table to the canonical alias `t`. */
export const THOUGHTS = 'thoughts t'

/**
 * WHERE fragment restricting to regular (non-cluster) thoughts. Pass a
 * status to require it too (the active-thought finders).
 */
export function regularThoughtsWhere(status?: ThoughtStatus): string {
  return status === undefined
    ? 't.is_cluster = 0'
    : `t.is_cluster = 0 AND t.status = '${status}'`
}

/** Equality binding one edge endpoint to its thought row. */
function edgeEndpoint(side: 'source' | 'target', thoughtAlias: string): string {
  return `e.${side}_id = ${thoughtAlias}.id`
}

/** Condition matching an edge on either endpoint of the thought. */
function eitherEndpoint(thoughtAlias: string): string {
  return `(${edgeEndpoint('source', thoughtAlias)} OR ${edgeEndpoint('target', thoughtAlias)})`
}

/** Incident-edge condition: which endpoints match, optionally type-filtered. */
function incidentOn(opts?: { sourceOnly?: boolean; type?: EdgeType }): string {
  const side = opts?.sourceOnly ? edgeEndpoint('source', 't') : eitherEndpoint('t')
  const type = opts?.type ? ` AND e.type = '${opts.type}'` : ''
  return `${side}${type}`
}

/** NOT EXISTS fragment: no incident edge of the given shape touches the thought. */
export function noIncidentEdges(opts?: { sourceOnly?: boolean; type?: EdgeType }): string {
  return `NOT EXISTS (SELECT 1 FROM edges e WHERE ${incidentOn(opts)})`
}

/** JOIN clause: the thought's incident edges, optionally type-filtered. */
export function joinIncidentEdges(opts?: { left?: boolean; sourceOnly?: boolean; type?: EdgeType }): string {
  return `${opts?.left ? 'LEFT ' : ''}JOIN edges e ON ${incidentOn(opts)}`
}

/** JOIN clause binding an edge endpoint to its thought row (edge-driven). */
export function joinEdgeEndpoint(side: 'source' | 'target', thoughtAlias: string, left = false): string {
  return `${left ? 'LEFT ' : ''}JOIN thoughts ${thoughtAlias} ON ${edgeEndpoint(side, thoughtAlias)}`
}
