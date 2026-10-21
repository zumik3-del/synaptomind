import { config } from '../config'
import { attemptPromote, getPrimerIds } from '../db/primers'
import { getDb } from '../db'
import { findHighHitThoughts } from '../db/importance'
import { getLogDb } from '../logging'
import { getLastSelfImproveRun, insertLog } from '../logging/log'
import { createIntervalJob } from './jobs'
import type { DetectedIssue, IssueId, SelfImproveSignals } from './self-improve-detect'
import { detectIssues } from './self-improve-detect'
import type { Database } from 'bun:sqlite'

export type { IssueId, DetectedIssue, SelfImproveSignals } from './self-improve-detect'

interface SelfImproveResult {
  dry_run: boolean
  signals: SelfImproveSignals
  issues: DetectedIssue[]
  actions_taken: string[]
  timestamp: string
}

type IssueHandler = (ctx: { db: Database; dryRun: boolean; actions: string[]; issue: DetectedIssue }) => void

const issueHandlers = new Map<IssueId, IssueHandler>()

function registerIssueHandler(id: IssueId, handler: IssueHandler): void {
  issueHandlers.set(id, handler)
}

registerIssueHandler('frequent_unpromoted', ({ db, dryRun, actions }) => {
  const { selfImprove: cfg } = config
  const highHit = findHighHitThoughts(db, cfg.hitsThreshold, cfg.maxPrimerPromotesPerRun)
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
})

function executeActions(issues: DetectedIssue[], dryRun: boolean, db: Database): string[] {
  const actions: string[] = []

  for (const issue of issues) {
    const handler = issueHandlers.get(issue.id)
    if (handler) handler({ db, dryRun, actions, issue })
  }

  return actions
}

export function getLastSelfImproveStatus(): { last_run: string | null; result: SelfImproveResult | null } {
  const logDb = getLogDb()
  if (!logDb) return { last_run: null, result: null }
  const row = getLastSelfImproveRun(logDb)
  if (!row) return { last_run: null, result: null }
  const parsed = row.metadata ? JSON.parse(row.metadata) : null
  return {
    last_run: row.created_at,
    result: parsed?.result ?? null
  }
}

export async function runSelfImproveJob(
  options: { dryRun?: boolean } = {},
  d: Database = getDb()
): Promise<SelfImproveResult> {
  const dryRun = options.dryRun ?? false
  const { selfImprove: cfg } = config
  const signals: SelfImproveSignals = {
    highHitThoughts: findHighHitThoughts(d, cfg.hitsThreshold)
  }
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
