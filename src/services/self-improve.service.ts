import { config } from '../config'
import { attemptPromote, getPrimerIds } from '../db/primers'
import { getDb } from '../db'
import { listThoughts } from '../db/thoughts'
import { getLogDb } from '../logging'
import { insertLog } from '../logging/log'
import { runAutoClusterJob } from './auto-cluster.service'
import { createIntervalJob } from './jobs'
import type { DetectedIssue } from './self-improve-detect'
import { detectIssues } from './self-improve-detect'
import type { TelemetrySignals } from './self-improve-telemetry'
import { queryTelemetrySignals } from './self-improve-telemetry'
import { updateThoughtById } from './thoughts.service'
import type { Database } from 'bun:sqlite'

export type { IssueId, DetectedIssue } from './self-improve-detect'
export type { TelemetrySignals } from './self-improve-telemetry'
export { queryTelemetrySignals } from './self-improve-telemetry'
export { detectIssues } from './self-improve-detect'

export interface SelfImproveResult {
  dry_run: boolean
  signals: TelemetrySignals
  issues: DetectedIssue[]
  actions_taken: string[]
  timestamp: string
}

type IssueHandler = (ctx: { db: Database; dryRun: boolean; actions: string[]; issue: DetectedIssue }) => void

const issueHandlers: Record<string, IssueHandler> = {
  orphan_writes_high: ({ db, dryRun, actions }) => {
    const draftThoughts = listThoughts(db, { status: 'draft', limit: 20 })
    if (draftThoughts.length >= 2) {
      const msg = `orphan_writes_high: ${draftThoughts.length} draft thoughts found — manual review recommended`
      actions.push(msg)
      if (!dryRun) insertLog('warn', 'self_improve', msg)
    }
  },

  low_activation_rate: ({ db, dryRun, actions }) => {
    const { selfImprove: cfg } = config
    const drafts = listThoughts(db, { status: 'draft', limit: cfg.maxPromotesPerRun * 2 })
    let promoted = 0
    for (const d of drafts) {
      if (promoted >= cfg.maxPromotesPerRun) break
      if (d.is_cluster || d.is_profile) continue
      const ageDays = (Date.now() - new Date(d.created_at).getTime()) / 86400000
      if (ageDays < 3) continue
      if (!dryRun) updateThoughtById(d.id, { status: 'active' })
      promoted++
      actions.push(`promote: ${d.id} (${d.content.slice(0, 50)}...)`)
    }
    if (promoted > 0) {
      insertLog('info', 'self_improve', `Promoted ${promoted} drafts to active`, { count: promoted.toString() })
    }
  },

  zero_clusters: ({ dryRun, actions }) => {
    actions.push('trigger: auto_cluster job')
    if (!dryRun) {
      runAutoClusterJob({ dryRun: false }).catch(err => {
        insertLog('warn', 'self_improve', 'auto_cluster trigger failed', { error: String(err) })
      })
    }
  },

  high_archive_rate: ({ actions, issue }) => {
    actions.push(`warn: ${issue.description}`)
  },

  frequent_unpromoted: ({ db, dryRun, actions }) => {
    const { selfImprove: cfg } = config
    const highHit = db
      .prepare(`SELECT thought_id AS id, hit_count FROM thought_importance WHERE hit_count >= ? ORDER BY hit_count DESC LIMIT ?`)
      .all(cfg.hitsThreshold, cfg.maxPrimerPromotesPerRun) as Array<{ id: string; hit_count: number }>
    const primerIds = new Set(getPrimerIds(db))
    let primerPromotes = 0
    for (const h of highHit) {
      if (primerPromotes >= cfg.maxPrimerPromotesPerRun) break
      if (primerIds.has(h.id)) continue
      if (!dryRun) attemptPromote(db, h.id, h.hit_count, config.primer.promoteThreshold)
      primerPromotes++
      actions.push(`primer_promote: ${h.id} (hits=${h.hit_count})`)
    }
    if (primerPromotes > 0) {
      insertLog('info', 'self_improve', `Promoted ${primerPromotes} thoughts to primers`, { count: primerPromotes.toString() })
    }
  }
}

function executeActions(issues: DetectedIssue[], dryRun: boolean, db: Database): string[] {
  const actions: string[] = []

  for (const issue of issues) {
    const handler = issueHandlers[issue.id]
    if (handler) handler({ db, dryRun, actions, issue })
  }

  return actions
}

export function getLastSelfImproveStatus(): { last_run: string | null; result: SelfImproveResult | null } {
  const logDb = getLogDb()
  if (!logDb) return { last_run: null, result: null }
  const row = logDb.prepare(
    `SELECT metadata, created_at FROM logs
     WHERE type = 'self_improve' AND message LIKE 'Self-improve run:%'
     ORDER BY created_at DESC LIMIT 1`
  ).get() as { metadata: string | null; created_at: string } | undefined
  if (!row) return { last_run: null, result: null }
  const parsed = row.metadata ? JSON.parse(row.metadata) : null
  return {
    last_run: row.created_at,
    result: parsed?.result ?? null
  }
}

export async function runSelfImproveJob(options: { dryRun?: boolean } = {}): Promise<SelfImproveResult> {
  const dryRun = options.dryRun ?? false
  const d = getDb()
  const signals = queryTelemetrySignals()
  const issues = detectIssues(signals)
  const actions = dryRun ? issues.map(i => `[dry-run] ${i.id}`) : executeActions(issues, dryRun, d)
  const result: SelfImproveResult = {
    dry_run: dryRun, signals, issues, actions_taken: actions, timestamp: new Date().toISOString()
  }
  if (!dryRun) {
    insertLog('info', 'self_improve', `Self-improve run: ${issues.length} issues, ${actions.length} actions`, {
      issues: issues.map(i => i.id).join(','),
      actions_count: actions.length.toString(),
      result
    })
  }
  return result
}

const job = createIntervalJob({
  name: 'self-improve',
  intervalMs: config.selfImprove.intervalMs,
  guard: () => config.selfImprove.enabled,
  onError: (err) => insertLog('error', 'self_improve', 'Self-improve job failed', { error: String(err) })
}, () => { void runSelfImproveJob() })

export function startSelfImproveJob(): void {
  job.start()
  insertLog('info', 'self_improve', 'Self-improve job started', { interval_ms: config.selfImprove.intervalMs.toString() })
}

export function stopSelfImproveJob(): void { job.stop() }
