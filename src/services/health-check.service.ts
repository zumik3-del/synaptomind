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
  getGraphStats, deleteEdges, archiveThoughts,
} from '../db/health-check'
import type { Database } from 'bun:sqlite'
import { findDuplicateDrafts } from './health-check-drafts.service'

export type Severity = 'critical' | 'warning' | 'info'

export interface CheckResult {
  name: string
  severity: Severity
  count: number
  details: unknown[]
  auto_fixable?: boolean
  autofix?: Autofix
}

export interface CategoryResult {
  name: string
  checks: CheckResult[]
}

interface ScoreBreakdown {
  critical_categories: number
  warning_categories: number
  /** All reported `info` occurrences (`summary.info`), scored or not. */
  info_occurrences: number
  /** The subset of `info_occurrences` the score actually charges. */
  info_scored_occurrences: number
  /** Findings whose `info` occurrences are reported but not scored. */
  info_unscored_checks: string[]
  penalty_critical: number
  penalty_warning: number
  penalty_info: number
  formula: string
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
    // Prominent, separate counts of issues by severity (raw occurrence counts).
    critical: number
    warning: number
    info: number
    critical_count: number
    warning_count: number
    info_count: number
    critical_issues: number
    warning_issues: number
    info_issues: number
    issues: { critical: number; warning: number; info: number }
    // How health_score is composed (category presence, not raw counts).
    score_breakdown: ScoreBreakdown
    score_composition: ScoreBreakdown
    score_explanation: ScoreBreakdown
    score_components: ScoreBreakdown
    score_details: ScoreBreakdown
    score_formula: string
    formula: string
  }
  categories: CategoryResult[]
}

interface HealthCheckOptions {
  severity?: Severity
}

type Autofix = (db: Database, details: unknown[]) => number | undefined

interface CheckDef {
  name: string
  severity: Severity
  finder: (db: Database) => unknown[]
  /** Declarative repair hook. Presence marks the check as auto-fixable. */
  autofix?: Autofix
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

/**
 * `info` findings that report graph *coverage* rather than a defect: their
 * occurrences are reported (and stay visible in `summary.info` and in the
 * `connectivity` category) but they carry no score penalty.
 *
 * A thought is an island the moment it is published, because activation
 * (`status: active`) precedes linking, so charging each island would make
 * publishing durable knowledge look like a health regression and discourage it
 * (task #1967). Islands are therefore informational only; the finding itself
 * is kept. Only `info` checks may be listed here — the `critical`/`warning`
 * terms are category-presence penalties and stay unchanged.
 */
const INFO_CHECKS_NOT_SCORED: ReadonlySet<string> = new Set(['island_thoughts'])

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
  return deleteEdges(db, (details as Array<{ id: string }>).map(e => e.id))
}

const autofixClusterMemberEdges: Autofix = (db, details) => {
  return deleteEdges(db, (details as Array<{ cluster_edge_id: string }>).map(m => m.cluster_edge_id))
}

const autofixThoughtIds: Autofix = (db, details) => {
  return archiveThoughts(db, (details as Array<{ id: string }>).map(t => t.id))
}

// Only edges whose target is *archived* are truly dangling (the node is out of
// the graph). A draft target is a legitimate in-progress child and is left for
// manual review.
const autofixArchivedParentEdges: Autofix = (db, details) => {
  const ids = (details as Array<{ edge_id: string; target_status: string }>)
    .filter(b => b.target_status === 'archived')
    .map(b => b.edge_id)
  if (ids.length === 0) return 0
  return deleteEdges(db, ids)
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
  // Age-gated by `autoCluster.minAgeDays` (finder default): auto-cluster only
  // sees candidates older than that window, so younger dense thoughts are not
  // yet actionable and must not be flagged as warnings.
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
  // Read-only by design: a duplicate draft needs a human merge/archive decision,
  // so `fix=true` must never act on it (task #1946).
  { name: 'duplicate_drafts', severity: 'warning', finder: findDuplicateDrafts },
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

export function runHealthCheckService(options: HealthCheckOptions = {}, d: Database = getDb()): HealthReport {
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
  let scoredInfo = 0
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
        if (!INFO_CHECKS_NOT_SCORED.has(check.name)) scoredInfo += check.count
      }
    }
    if (catCritical) criticalCats++
    if (catWarning) warningCats++
  }

  // Penalise the PRESENCE of a category with issues rather than the raw
  // occurrence count: structural critical categories hit hard, warning
  // categories moderately, info occurrences slightly. This keeps health_score
  // a reflection of structural health and prevents it from being zeroed out by
  // many harmless warning cases (like parent->draft). Info occurrences of
  // coverage findings (`INFO_CHECKS_NOT_SCORED`) are reported but not charged.
  const health_score = Math.max(0, Math.min(100,
    100 - (criticalCats * 40) - (warningCats * 15) - (scoredInfo * 0.25)
  ))

  const penaltyCritical = criticalCats * 40
  const penaltyWarning = warningCats * 15
  const penaltyInfo = scoredInfo * 0.25
  const scoreBreakdown: ScoreBreakdown = {
    critical_categories: criticalCats,
    warning_categories: warningCats,
    info_occurrences: info,
    info_scored_occurrences: scoredInfo,
    info_unscored_checks: [...INFO_CHECKS_NOT_SCORED],
    penalty_critical: penaltyCritical,
    penalty_warning: penaltyWarning,
    penalty_info: penaltyInfo,
    formula: '100 - (critical_categories * 40) - (warning_categories * 15) - (info_scored_occurrences * 0.25), clamped to [0, 100]'
  }

  return {
    summary: {
      ...stats,
      health_score: Math.round(health_score * 10) / 10,
      // Prominent, separate counts of issues by severity.
      critical,
      warning,
      info,
      critical_count: critical,
      warning_count: warning,
      info_count: info,
      critical_issues: critical,
      warning_issues: warning,
      info_issues: info,
      issues: { critical, warning, info },
      // How health_score is composed (category presence, not raw counts).
      score_breakdown: scoreBreakdown,
      score_composition: scoreBreakdown,
      score_explanation: scoreBreakdown,
      score_components: scoreBreakdown,
      score_details: scoreBreakdown,
      score_formula: scoreBreakdown.formula,
      formula: scoreBreakdown.formula
    },
    categories
  }
}

export type { HealthRepairResult } from './health-check-repair.service'
