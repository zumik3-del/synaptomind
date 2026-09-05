import { getDb } from '../db'
import {
  findOrphanEdges, findSelfLoopEdges, findDuplicateEdges, findClusterViolations,
  findEmptyClusters, findSingletonClusters, findOrphanedClusterMembers, findClusterlessDense,
  findIslandThoughts, findOverlinkedThoughts,
  findDuplicateContent, findTooShort, findTestRemnants, findStaleDrafts, findUntagged,
  findCircularChains, findBrokenParentChains, findReplacesChains,
  findMissingEmbeddings, findDeadPrimers, findImportanceOutliers,
  getGraphStats, deleteEdges, deleteThoughts,
  type OrphanEdge, type SelfLoopEdge, type EmptyCluster, type OrphanedClusterMember, type TestRemnant,
} from '../db/health-check'
import type { Database } from 'bun:sqlite'

export type Severity = 'critical' | 'warning' | 'info'

export interface CheckResult {
  name: string
  severity: Severity
  count: number
  details: unknown[]
  auto_fixable?: boolean
}

export interface CategoryResult {
  name: string
  checks: CheckResult[]
}

export interface HealthReport {
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

export interface HealthCheckOptions {
  severity?: Severity
  project_id?: string
  fix?: boolean
}

interface CheckDef {
  name: string
  severity: Severity
  finder: (db: Database) => unknown[]
  auto_fixable?: boolean
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

function matchesSeverity(check: CheckResult, minSeverity?: Severity): boolean {
  if (!minSeverity) return true
  return SEVERITY_ORDER[check.severity] <= SEVERITY_ORDER[minSeverity]
}

function runChecks(db: Database, checks: CheckDef[]): CheckResult[] {
  return checks.map(({ name, severity, finder, auto_fixable }) => {
    const details = finder(db)
    return { name, severity, count: details.length, details, auto_fixable }
  })
}

const STRUCTURAL_CHECKS: CheckDef[] = [
  { name: 'orphan_edges', severity: 'critical', finder: findOrphanEdges, auto_fixable: true },
  { name: 'self_loop_edges', severity: 'critical', finder: findSelfLoopEdges, auto_fixable: true },
  { name: 'duplicate_edges', severity: 'critical', finder: findDuplicateEdges },
  { name: 'cluster_constraint_violations', severity: 'critical', finder: findClusterViolations },
]

const CLUSTER_CHECKS: CheckDef[] = [
  { name: 'empty_clusters', severity: 'warning', finder: findEmptyClusters, auto_fixable: true },
  { name: 'singleton_clusters', severity: 'warning', finder: findSingletonClusters },
  { name: 'orphaned_cluster_members', severity: 'warning', finder: findOrphanedClusterMembers, auto_fixable: true },
  { name: 'clusterless_dense_thoughts', severity: 'warning', finder: findClusterlessDense },
]

const CONNECTIVITY_CHECKS: CheckDef[] = [
  { name: 'island_thoughts', severity: 'warning', finder: findIslandThoughts },
  { name: 'overlinked_thoughts', severity: 'warning', finder: findOverlinkedThoughts },
]

const CONTENT_CHECKS: CheckDef[] = [
  { name: 'duplicate_content', severity: 'info', finder: findDuplicateContent },
  { name: 'too_short_content', severity: 'info', finder: findTooShort },
  { name: 'test_remnants', severity: 'info', finder: findTestRemnants, auto_fixable: true },
  { name: 'stale_drafts', severity: 'info', finder: findStaleDrafts },
  { name: 'untagged_thoughts', severity: 'info', finder: findUntagged },
]

const SEMANTIC_CHECKS: CheckDef[] = [
  { name: 'circular_chains', severity: 'warning', finder: findCircularChains },
  { name: 'broken_parent_chains', severity: 'warning', finder: findBrokenParentChains },
  { name: 'replaces_chains', severity: 'warning', finder: findReplacesChains },
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

export function runHealthCheck(options: HealthCheckOptions = {}): HealthReport {
  const d = getDb()
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
  for (const cat of categories) {
    for (const check of cat.checks) {
      if (check.severity === 'critical') critical += check.count
      else if (check.severity === 'warning') warning += check.count
      else info += check.count
    }
  }

  const health_score = Math.max(0, Math.min(100,
    100 - (critical * 10) - (warning * 3) - (info * 0.5)
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
      if (!check.auto_fixable || check.count === 0) continue

      switch (check.name) {
        case 'orphan_edges': {
          const ids = (check.details as OrphanEdge[]).map(e => e.id)
          deleteEdges(db, ids)
          break
        }
        case 'self_loop_edges': {
          const ids = (check.details as SelfLoopEdge[]).map(e => e.id)
          deleteEdges(db, ids)
          break
        }
        case 'empty_clusters': {
          const ids = (check.details as EmptyCluster[]).map(c => c.id)
          deleteThoughts(db, ids)
          break
        }
        case 'orphaned_cluster_members': {
          const ids = (check.details as OrphanedClusterMember[]).map(m => m.cluster_edge_id)
          deleteEdges(db, ids)
          break
        }
        case 'test_remnants': {
          const ids = (check.details as TestRemnant[]).map(t => t.id)
          deleteThoughts(db, ids)
          break
        }
      }
    }
  }
}
