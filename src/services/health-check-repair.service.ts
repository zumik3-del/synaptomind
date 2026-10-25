import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import { runHealthCheckService } from './health-check.service'
import type { HealthReport, Severity } from './health-check.service'
import { createPreviewTokenService, consumePreviewTokenService } from './preview-tokens.service'

export interface HealthRepairResult {
  status: 'preview' | 'executed'
  action: 'repair'
  preview_token?: string
  repairable?: Array<{ category: string; name: string; count: number }>
  repaired?: Array<{ category: string; name: string; count: number }>
  report?: HealthReport
}

function runAutoFix(db: Database, categories: HealthReport['categories']): Array<{ category: string; name: string; count: number }> {
  const repaired: Array<{ category: string; name: string; count: number }> = []
  for (const cat of categories) {
    for (const check of cat.checks) {
      if (!check.autofix || check.count === 0) continue
      const actual = check.autofix(db, check.details) ?? 0
      if (actual > 0) repaired.push({ category: cat.name, name: check.name, count: actual })
    }
  }
  return repaired
}

function healthRepairFingerprint(report: HealthReport): string {
  const ids: string[] = []
  for (const cat of report.categories) {
    for (const check of cat.checks) {
      if (!check.auto_fixable || check.count === 0) continue
      const details = Array.isArray(check.details) ? check.details : []
      for (const detail of details as Array<Record<string, unknown>>) {
        if (check.name === 'broken_parent_chains') {
          if (detail.target_status === 'archived' && typeof detail.edge_id === 'string') ids.push(detail.edge_id)
        } else if (check.name === 'orphaned_cluster_members') {
          if (typeof detail.cluster_edge_id === 'string') ids.push(detail.cluster_edge_id)
        } else if (typeof detail.id === 'string') {
          ids.push(detail.id)
        }
      }
    }
  }
  return [...new Set(ids)].sort().join('|') || 'none'
}

export function runHealthRepairService(
  options: { confirm?: boolean; preview_token?: string; severity?: Severity } = {},
  d: Database = getDb(),
): HealthRepairResult {
  const confirm = options.confirm === true
  const fullReport = runHealthCheckService({}, d)
  const repairable = fullReport.categories.flatMap(cat =>
    cat.checks
      .filter(ch => ch.auto_fixable && ch.count > 0)
      .map(ch => ({ category: cat.name, name: ch.name, count: ch.count }))
  )
  const fingerprint = healthRepairFingerprint(fullReport)

  if (!confirm) {
    const token = createPreviewTokenService('health_repair', 'health', fingerprint, d)
    return { status: 'preview', action: 'repair', preview_token: token, repairable }
  }

  const previewToken = options.preview_token
  if (!previewToken) throw new ValidationError('preview_token is required')
  const verification = consumePreviewTokenService(previewToken, 'health_repair', 'health', fingerprint, d)
  if (!verification.valid) throw new ValidationError(`preview token ${verification.reason ?? 'invalid'}`)

  const repaired = runAutoFix(d, fullReport.categories)

  const report = runHealthCheckService({ severity: options.severity }, d)
  return { status: 'executed', action: 'repair', repaired, report }
}

