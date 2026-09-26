import { getDb } from '../db'
import {
  findOrphanEdges, findSelfLoopEdges, findDuplicateEdges, findClusterViolations,
  findEmptyClusters, findSingletonClusters, findOrphanedClusterMembers, findClusterlessDense,
  findIslandThoughts, findOverlinkedThoughts,
  findDuplicateContent, findTooShort, findTestRemnants, findStaleDrafts, findUntagged,
  findCircularChains, findBrokenParentChains, findReplacesChains,
  findContradictsWithHierarchy, findContradictsRedundantWithReplaces, findContradictionInCluster,
  findContradictsToArchived, findSupportsSelfConflict,
  findMissingEmbeddings, findDeadPrimers, findImportanceOutliers,
  getGraphStats, deleteEdges, deleteThoughts,
} from '../db/health-check'
import type { Database } from 'bun:sqlite'

export type Severity = 'critical' | 'warning' | 'info'

interface CheckResult {
  name: string
  severity: Severity
  count: number
  details: unknown[]
  auto_fixable?: boolean
  autofix?: Autofix
}

interface CategoryResult {
  name: string
  checks: CheckResult[]
}

interface HealthReport {
  summary: {
    total_thoughts: number
    total_edges: number
    total_clusters: number
    active: number
    draft: number
    archived: number
    health_score: number
    issues: { critical: number; warning: number; info: number }
  }
  categories: CategoryResult[]
}

interface HealthCheckOptions {
  severity?: Severity
  project_id?: string
  fix?: boolean
}

type Autofix = (db: Database, details: unknown[]) => void

interface CheckDef {
  name: string
  severity: Severity
  finder: (db: Database) => unknown[]
  /** Declarative repair hook. Presence marks the check as auto-fixable. */
  autofix?: Autofix
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

function matchesSeverity(check: CheckResult, minSeverity?: Severity): boolean {
  if (!minSeverity) return true
  return SEVERITY_ORDER[check.severity] <= SEVERITY_ORDER[minSeverity]
}

function runChecks(db: Database, checks: CheckDef[]): CheckResult[] {
  return checks.map(({ name, severity, finder, autofix }) => {
    const details = finder(db)
    return { name, severity, count: details.length, details, auto_fixable: autofix ? true : undefined, autofix }
  })
}

const autofixEdgeIds: Autofix = (db, details) => {
  deleteEdges(db, (details as Array<{ id: string }>).map(e => e.id))
}

const autofixClusterMemberEdges: Autofix = (db, details) => {
  deleteEdges(db, (details as Array<{ cluster_edge_id: string }>).map(m => m.cluster_edge_id))
}

const autofixThoughtIds: Autofix = (db, details) => {
  deleteThoughts(db, (details as Array<{ id: string }>).map(t => t.id))
}

// Only edges whose target is *archived* are truly dangling (the node is out of
// the graph). A draft target is a legitimate in-progress child and is left for
// manual review.
const autofixArchivedParentEdges: Autofix = (db, details) => {
  const ids = (details as Array<{ edge_id: string; target_status: string }>)
    .filter(b => b.target_status === 'archived')
    .map(b => b.edge_id)
  if (ids.length > 0) deleteEdges(db, ids)
}

const STRUCTURAL_CHECKS: CheckDef[] = [
  { name: 'orphan_edges', severity: 'critical', finder: findOrphanEdges, autofix: autofixEdgeIds },
  { name: 'self_loop_edges', severity: 'critical', finder: findSelfLoopEdges, autofix: autofixEdgeIds },
  { name: 'duplicate_edges', severity: 'critical', finder: findDuplicateEdges },
  { name: 'cluster_constraint_violations', severity: 'critical', finder: findClusterViolations },
]

const CLUSTER_CHECKS: CheckDef[] = [
  { name: 'empty_clusters', severity: 'warning', finder: findEmptyClusters, autofix: autofixThoughtIds },
  { name: 'singleton_clusters', severity: 'warning', finder: findSingletonClusters },
  { name: 'orphaned_cluster_members', severity: 'warning', finder: findOrphanedClusterMembers, autofix: autofixClusterMemberEdges },
  { name: 'clusterless_dense_thoughts', severity: 'warning', finder: findClusterlessDense },
]

const CONNECTIVITY_CHECKS: CheckDef[] = [
  { name: 'island_thoughts', severity: 'info', finder: findIslandThoughts },
  { name: 'overlinked_thoughts', severity: 'warning', finder: findOverlinkedThoughts },
]

const CONTENT_CHECKS: CheckDef[] = [
  { name: 'duplicate_content', severity: 'info', finder: findDuplicateContent },
  { name: 'too_short_content', severity: 'info', finder: findTooShort },
  { name: 'test_remnants', severity: 'info', finder: findTestRemnants, autofix: autofixThoughtIds },
  { name: 'stale_drafts', severity: 'info', finder: findStaleDrafts },
  { name: 'untagged_thoughts', severity: 'info', finder: findUntagged },
]

const SEMANTIC_CHECKS: CheckDef[] = [
  { name: 'circular_chains', severity: 'warning', finder: findCircularChains },
  { name: 'broken_parent_chains', severity: 'warning', finder: findBrokenParentChains, autofix: autofixArchivedParentEdges },
  { name: 'replaces_chains', severity: 'warning', finder: findReplacesChains },
  { name: 'contradicts_with_hierarchy', severity: 'warning', finder: findContradictsWithHierarchy },
  { name: 'contradiction_in_cluster', severity: 'warning', finder: findContradictionInCluster },
  { name: 'contradicts_redundant_with_replaces', severity: 'info', finder: findContradictsRedundantWithReplaces },
  { name: 'contradicts_to_archived', severity: 'info', finder: findContradictsToArchived },
  { name: 'supports_self_conflict', severity: 'critical', finder: findSupportsSelfConflict },
]

const DRIFT_CHECKS: CheckDef[] = [
  { name: 'missing_embeddings', severity: 'info', finder: findMissingEmbeddings },
  { name: 'dead_primers', severity: 'info', finder: findDeadPrimers },
  { name: 'importance_outliers', severity: 'info', finder: findImportanceOutliers },
]

const CATEGORIES: Array<{ name: string; checks: CheckDef[] }> = [
  { name: 'structural_integrity', checks: STRUCTURAL_CHECKS },
  { name: 'cluster_health', checks: CLUSTER_CHECKS },
  { name: 'connectivity', checks: CONNECTIVITY_CHECKS },
  { name: 'content_quality', checks: CONTENT_CHECKS },
  { name: 'semantic_consistency', checks: SEMANTIC_CHECKS },
  { name: 'data_drift', checks: DRIFT_CHECKS },
]

export function runHealthCheck(options: HealthCheckOptions = {}, d: Database = getDb()): HealthReport {
  const stats = getGraphStats(d)

  let categories: CategoryResult[] = CATEGORIES.map(({ name, checks }) => ({
    name,
    checks: runChecks(d, checks)
  }))

  if (options.severity) {
    categories = categories
      .map(c => ({ ...c, checks: c.checks.filter(ch => matchesSeverity(ch, options.severity)) }))
      .filter(c => c.checks.length > 0)
  }

  let critical = 0, warning = 0, info = 0
  let criticalCats = 0, warningCats = 0
  for (const cat of categories) {
    let catCritical = false, catWarning = false
    for (const check of cat.checks) {
      if (check.severity === 'critical') {
        critical += check.count
        if (check.count > 0) catCritical = true
      } else if (check.severity === 'warning') {
        warning += check.count
        if (check.count > 0) catWarning = true
      } else {
        info += check.count
      }
    }
    if (catCritical) criticalCats++
    if (catWarning) warningCats++
  }

  // Penalise the PRESENCE of a category with issues rather than the raw
  // occurrence count: structural critical categories hit hard, warning
  // categories moderately, info occurrences slightly. This keeps health_score
  // a reflection of structural health and prevents it from being zeroed out by
  // many harmless warning cases (like parent->draft).
  const health_score = Math.max(0, Math.min(100,
    100 - (criticalCats * 40) - (warningCats * 15) - (info * 0.25)
  ))

  if (options.fix) {
    runAutoFix(d, categories)
  }

  return {
    summary: {
      ...stats,
      health_score: Math.round(health_score * 10) / 10,
      issues: { critical, warning, info }
    },
    categories
  }
}

function runAutoFix(db: Database, categories: CategoryResult[]): void {
  for (const cat of categories) {
    for (const check of cat.checks) {
      if (!check.autofix || check.count === 0) continue
      check.autofix(db, check.details)
    }
  }
}
