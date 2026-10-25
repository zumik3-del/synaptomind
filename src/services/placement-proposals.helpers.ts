import { config } from '../config'
import type { EnqueuePlanOptions, EnqueueThoughtOptions } from './placement-proposals.types'

/** Default and hard ceiling of the `list` page size (matches the MCP schema). */
export const DEFAULT_LIST_LIMIT = 100
export const MAX_LIST_LIMIT = 1000

/** Resolve the per-enqueue proposal cap from options/config (first defined wins). */
export function resolveMaxProposalsPerEnqueue(options: EnqueuePlanOptions | EnqueueThoughtOptions = {}): number {
  const o = options as Record<string, unknown>
  const candidates = [
    o.maxProposals, o.max_proposals, o.maxItems, o.max_items,
    o.maxItemsPerEnqueue, o.max_items_per_enqueue,
    o.maxProposalsPerEnqueue, o.max_proposals_per_enqueue, o.limit
  ]
  for (const c of candidates) {
    if (c !== undefined && c !== null && Number.isFinite(c as number)) {
      return Math.max(1, Math.floor(c as number))
    }
  }
  const cfg = config.placement as Record<string, unknown>
  const cfgCandidates = [
    cfg.maxProposalsPerEnqueue, cfg.maxProposals, cfg.maxItemsPerEnqueue, cfg.maxItemsPerRun,
    (config.edgeDetect as Record<string, unknown>)?.maxProposals
  ]
  for (const c of cfgCandidates) {
    if (c !== undefined && c !== null && Number.isFinite(c as number)) {
      return Math.max(1, Math.floor(c as number))
    }
  }
  return 5
}

/**
 * Clamp a caller-supplied page size into `1..1000`. Without this an unbounded or
 * negative value reaches SQLite, where `LIMIT -1` means *no limit* and `LIMIT 0`
 * returns nothing — so one request could read the whole queue.
 */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)))
}
