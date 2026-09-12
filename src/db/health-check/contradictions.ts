import type { Database } from 'bun:sqlite'
import type {
  ContradictionInCluster,
  ContradictsRedundantWithReplaces,
  ContradictsToArchived,
  ContradictsWithHierarchy,
  SupportsSelfConflict,
} from './types'

/**
 * A `contradicts` pair whose endpoints are also connected by a directed
 * `parent`/`develops` hierarchy path (ancestor or descendant). Hierarchy and
 * conflict disagree, so at least one of the two relations is wrong.
 *
 * `contradicts` is symmetric, so a cycle of contradictions is not a meaningful
 * signal; the hierarchy interaction is the actionable check instead.
 */
export function findContradictsWithHierarchy(db: Database): ContradictsWithHierarchy[] {
  return db.prepare(`
    WITH RECURSIVE hierarchy(root, node) AS (
      SELECT source_id, target_id FROM edges WHERE type IN ('parent', 'develops')
      UNION
      SELECT hierarchy.root, e.target_id
      FROM hierarchy
      JOIN edges e ON e.source_id = hierarchy.node AND e.type IN ('parent', 'develops')
    )
    SELECT DISTINCT c.id AS edge_id, c.source_id, c.target_id
    FROM edges c
    JOIN hierarchy h
      ON (h.root = c.source_id AND h.node = c.target_id)
      OR (h.root = c.target_id AND h.node = c.source_id)
    WHERE c.type = 'contradicts'
  `).all() as ContradictsWithHierarchy[]
}

/**
 * A `contradicts` edge on the same unordered pair as a `replaces` edge: the
 * supersession already resolved the conflict, so the stance edge is redundant
 * (normally impossible through `createEdge`, catches migration/junk rows).
 */
export function findContradictsRedundantWithReplaces(db: Database): ContradictsRedundantWithReplaces[] {
  return db.prepare(`
    SELECT DISTINCT
      c.id AS contradicts_edge_id,
      r.id AS replaces_edge_id,
      c.source_id AS source_id,
      c.target_id AS target_id
    FROM edges c
    JOIN edges r ON r.type = 'replaces' AND (
      (r.source_id = c.source_id AND r.target_id = c.target_id) OR
      (r.source_id = c.target_id AND r.target_id = c.source_id)
    )
    WHERE c.type = 'contradicts'
  `).all() as ContradictsRedundantWithReplaces[]
}

/**
 * Two members of the same cluster contradict each other: the consolidated
 * claim is ambiguous until the conflict is resolved.
 */
export function findContradictionInCluster(db: Database): ContradictionInCluster[] {
  return db.prepare(`
    SELECT DISTINCT
      ce1.source_id AS cluster_id,
      ce1.target_id AS member_a,
      ce2.target_id AS member_b,
      c.id AS contradicts_edge_id
    FROM edges ce1
    JOIN edges ce2
      ON ce2.source_id = ce1.source_id
      AND ce2.type = 'cluster'
      AND ce2.target_id > ce1.target_id
    JOIN edges c
      ON c.type = 'contradicts'
      AND (
        (c.source_id = ce1.target_id AND c.target_id = ce2.target_id) OR
        (c.source_id = ce2.target_id AND c.target_id = ce1.target_id)
      )
    WHERE ce1.type = 'cluster'
  `).all() as ContradictionInCluster[]
}

/** Both endpoints of a `contradicts` edge are archived: stale conflict, a cleanup candidate. */
export function findContradictsToArchived(db: Database): ContradictsToArchived[] {
  return db.prepare(`
    SELECT e.id AS edge_id, e.source_id, e.target_id
    FROM edges e
    JOIN thoughts s ON s.id = e.source_id
    JOIN thoughts t ON t.id = e.target_id
    WHERE e.type = 'contradicts' AND s.status = 'archived' AND t.status = 'archived'
  `).all() as ContradictsToArchived[]
}

/**
 * The same unordered pair carries both `supports` and `contradicts`. Under the
 * one-edge-per-pair rule this cannot happen via `createEdge`; it flags junk or
 * externally-inserted rows that break the invariant.
 */
export function findSupportsSelfConflict(db: Database): SupportsSelfConflict[] {
  return db.prepare(`
    SELECT DISTINCT
      s.id AS supports_edge_id,
      c.id AS contradicts_edge_id,
      s.source_id AS source_id,
      s.target_id AS target_id
    FROM edges s
    JOIN edges c ON c.type = 'contradicts' AND (
      (c.source_id = s.source_id AND c.target_id = s.target_id) OR
      (c.source_id = s.target_id AND c.target_id = s.source_id)
    )
    WHERE s.type = 'supports'
  `).all() as SupportsSelfConflict[]
}
