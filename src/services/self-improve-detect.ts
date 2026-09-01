import { config } from '../config'
import type { TelemetrySignals } from './self-improve-telemetry'

export type IssueId =
  | 'orphan_writes_high'
  | 'low_activation_rate'
  | 'zero_clusters'
  | 'high_archive_rate'
  | 'frequent_unpromoted'

export interface DetectedIssue {
  id: IssueId
  description: string
  severity: 'info' | 'warn' | 'action'
}

export function detectIssues(signals: TelemetrySignals): DetectedIssue[] {
  const issues: DetectedIssue[] = []
  const { selfImprove: cfg } = config

  if (signals.totalWrites >= 5 && signals.orphanRate > cfg.orphanThreshold) {
    issues.push({
      id: 'orphan_writes_high',
      description: `Orphan write rate ${(signals.orphanRate * 100).toFixed(0)}% exceeds threshold (${(cfg.orphanThreshold * 100).toFixed(0)}%)`,
      severity: 'action'
    })
  }

  if (signals.draftCreates >= 5 && signals.activationRate < cfg.activationThreshold) {
    issues.push({
      id: 'low_activation_rate',
      description: `Activation rate ${(signals.activationRate * 100).toFixed(0)}% below threshold (${(cfg.activationThreshold * 100).toFixed(0)}%)`,
      severity: 'action'
    })
  }

  if (signals.totalWrites > 0 && signals.clusterOps === 0) {
    issues.push({
      id: 'zero_clusters',
      description: 'No cluster/link/merge operations detected despite write activity',
      severity: 'warn'
    })
  }

  if (signals.draftCreates > 0 && signals.archives > signals.draftCreates * 0.5) {
    issues.push({
      id: 'high_archive_rate',
      description: `Archive rate high: ${signals.archives} archives vs ${signals.draftCreates} creates`,
      severity: 'info'
    })
  }

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
