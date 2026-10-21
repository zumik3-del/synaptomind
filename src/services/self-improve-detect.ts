import { config } from '../config'

export type IssueId = 'frequent_unpromoted'

export interface DetectedIssue {
  id: IssueId
  description: string
  severity: 'info' | 'warn' | 'action'
}

/**
 * The measurements the surviving detection consumes.
 *
 * `highHitThoughts` is read from the main db (`thought_importance.hit_count`),
 * so the job no longer depends on the log db for its detection.
 */
export interface SelfImproveSignals {
  highHitThoughts: Array<{ id: string; hit_count: number }>
}

export function detectIssues(signals: SelfImproveSignals): DetectedIssue[] {
  const issues: DetectedIssue[] = []
  const { selfImprove: cfg } = config

  const unpromoted = signals.highHitThoughts.filter(h => h.hit_count >= cfg.hitsThreshold)
  if (unpromoted.length > 0) {
    issues.push({
      id: 'frequent_unpromoted',
      description: `${unpromoted.length} thoughts with hit_count >= ${cfg.hitsThreshold} not yet primers`,
      severity: 'action'
    })
  }

  return issues
}
