import type { CategoryResult, ScoreBreakdown } from './health-check.types'

const CRITICAL_CATEGORY_PENALTY = 40
const WARNING_CATEGORY_PENALTY = 15
const INFO_OCCURRENCE_PENALTY = 0.25

const INFO_CHECKS_NOT_SCORED: ReadonlySet<string> = new Set(['island_thoughts'])

interface HealthScoreSummary {
  health_score: number
  critical: number
  warning: number
  info: number
  breakdown: ScoreBreakdown
}

export function scoreCategories(categories: CategoryResult[]): HealthScoreSummary {
  let critical = 0,
    warning = 0,
    info = 0
  let scoredInfo = 0
  let criticalCats = 0,
    warningCats = 0
  for (const cat of categories) {
    let catCritical = false,
      catWarning = false
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

  const penaltyCritical = criticalCats * CRITICAL_CATEGORY_PENALTY
  const penaltyWarning = warningCats * WARNING_CATEGORY_PENALTY
  const penaltyInfo = scoredInfo * INFO_OCCURRENCE_PENALTY
  const healthScore = Math.max(
    0,
    Math.min(100, 100 - penaltyCritical - penaltyWarning - penaltyInfo)
  )
  const breakdown: ScoreBreakdown = {
    critical_categories: criticalCats,
    warning_categories: warningCats,
    info_occurrences: info,
    info_scored_occurrences: scoredInfo,
    info_unscored_checks: [...INFO_CHECKS_NOT_SCORED],
    penalty_critical: penaltyCritical,
    penalty_warning: penaltyWarning,
    penalty_info: penaltyInfo,
    formula: `100 - (critical_categories * ${CRITICAL_CATEGORY_PENALTY}) - (warning_categories * ${WARNING_CATEGORY_PENALTY}) - (info_scored_occurrences * ${INFO_OCCURRENCE_PENALTY}), clamped to [0, 100]`
  }

  return {
    health_score: Math.round(healthScore * 10) / 10,
    critical,
    warning,
    info,
    breakdown
  }
}
