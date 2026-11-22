import type { Database } from 'bun:sqlite'
import {
  findOrphanEdges,
  findSelfLoopEdges,
  findDuplicateEdges,
  findClusterViolations,
  findEmptyClusters,
  findSingletonClusters,
  findOrphanedClusterMembers,
  findClusterlessDense,
  findIslandThoughts,
  findOverlinkedThoughts,
  findDuplicateContent,
  findTooShort,
  findTestRemnants,
  findStaleDrafts,
  findUntagged,
  findCircularChains,
  findBrokenParentChains,
  findReplacesChains,
  findContradictsWithHierarchy,
  findContradictsRedundantWithReplaces,
  findContradictionInCluster,
  findContradictsToArchived,
  findSupportsSelfConflict,
  findMissingEmbeddings,
  findScopeMismatches,
  findDeadPrimers,
  findImportanceOutliers,
  deleteEdges,
  archiveThoughts
} from '../db/health-check'
import type { Autofix, CheckDef, CheckResult } from './health-check.types'
import { findDuplicateDrafts } from './health-check-drafts.service'

const autofixEdgeIds: Autofix = (db, details) => {
  return deleteEdges(
    db,
    (details as Array<{ id: string }>).map(e => e.id)
  )
}

const autofixClusterMemberEdges: Autofix = (db, details) => {
  return deleteEdges(
    db,
    (details as Array<{ cluster_edge_id: string }>).map(m => m.cluster_edge_id)
  )
}

const autofixThoughtIds: Autofix = (db, details) => {
  return archiveThoughts(
    db,
    (details as Array<{ id: string }>).map(t => t.id)
  )
}

const autofixArchivedParentEdges: Autofix = (db, details) => {
  const ids = (details as Array<{ edge_id: string; target_status: string }>)
    .filter(b => b.target_status === 'archived')
    .map(b => b.edge_id)
  if (ids.length === 0) return 0
  return deleteEdges(db, ids)
}

const STRUCTURAL_CHECKS: CheckDef[] = [
  { name: 'orphan_edges', severity: 'critical', finder: findOrphanEdges, autofix: autofixEdgeIds },
  {
    name: 'self_loop_edges',
    severity: 'critical',
    finder: findSelfLoopEdges,
    autofix: autofixEdgeIds
  },
  { name: 'duplicate_edges', severity: 'critical', finder: findDuplicateEdges },
  { name: 'cluster_constraint_violations', severity: 'critical', finder: findClusterViolations }
]

const CLUSTER_CHECKS: CheckDef[] = [
  {
    name: 'empty_clusters',
    severity: 'warning',
    finder: findEmptyClusters,
    autofix: autofixThoughtIds
  },
  { name: 'singleton_clusters', severity: 'warning', finder: findSingletonClusters },
  {
    name: 'orphaned_cluster_members',
    severity: 'warning',
    finder: findOrphanedClusterMembers,
    autofix: autofixClusterMemberEdges
  },
  { name: 'clusterless_dense_thoughts', severity: 'warning', finder: findClusterlessDense }
]

const CONNECTIVITY_CHECKS: CheckDef[] = [
  { name: 'island_thoughts', severity: 'info', finder: findIslandThoughts },
  { name: 'overlinked_thoughts', severity: 'warning', finder: findOverlinkedThoughts }
]

const CONTENT_CHECKS: CheckDef[] = [
  { name: 'duplicate_content', severity: 'info', finder: findDuplicateContent },
  { name: 'too_short_content', severity: 'info', finder: findTooShort },
  { name: 'test_remnants', severity: 'info', finder: findTestRemnants, autofix: autofixThoughtIds },
  { name: 'stale_drafts', severity: 'info', finder: findStaleDrafts },
  { name: 'duplicate_drafts', severity: 'warning', finder: findDuplicateDrafts },
  { name: 'untagged_thoughts', severity: 'info', finder: findUntagged }
]

const SEMANTIC_CHECKS: CheckDef[] = [
  { name: 'circular_chains', severity: 'warning', finder: findCircularChains },
  {
    name: 'broken_parent_chains',
    severity: 'warning',
    finder: findBrokenParentChains,
    autofix: autofixArchivedParentEdges
  },
  { name: 'replaces_chains', severity: 'warning', finder: findReplacesChains },
  { name: 'contradicts_with_hierarchy', severity: 'warning', finder: findContradictsWithHierarchy },
  { name: 'contradiction_in_cluster', severity: 'warning', finder: findContradictionInCluster },
  {
    name: 'contradicts_redundant_with_replaces',
    severity: 'info',
    finder: findContradictsRedundantWithReplaces
  },
  { name: 'contradicts_to_archived', severity: 'info', finder: findContradictsToArchived },
  { name: 'supports_self_conflict', severity: 'critical', finder: findSupportsSelfConflict }
]

const DRIFT_CHECKS: CheckDef[] = [
  { name: 'missing_embeddings', severity: 'info', finder: findMissingEmbeddings },
  { name: 'vector_scope_mismatch', severity: 'warning', finder: findScopeMismatches },
  { name: 'dead_primers', severity: 'info', finder: findDeadPrimers },
  { name: 'importance_outliers', severity: 'info', finder: findImportanceOutliers }
]

export const CATEGORIES: Array<{ name: string; checks: CheckDef[] }> = [
  { name: 'structural_integrity', checks: STRUCTURAL_CHECKS },
  { name: 'cluster_health', checks: CLUSTER_CHECKS },
  { name: 'connectivity', checks: CONNECTIVITY_CHECKS },
  { name: 'content_quality', checks: CONTENT_CHECKS },
  { name: 'semantic_consistency', checks: SEMANTIC_CHECKS },
  { name: 'data_drift', checks: DRIFT_CHECKS }
]

export function runChecks(db: Database, checks: CheckDef[]): CheckResult[] {
  return checks.map(({ name, severity, finder, autofix }) => {
    const details = finder(db)
    return {
      name,
      severity,
      count: details.length,
      details,
      auto_fixable: autofix ? true : undefined,
      autofix
    }
  })
}
