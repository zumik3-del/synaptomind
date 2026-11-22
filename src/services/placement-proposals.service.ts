import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import {
  countProposals,
  getProposal,
  insertProposal,
  listAcceptedProposalsByRun,
  listProposals,
  updateProposalState,
  type InsertProposalInput,
  type ListProposalsOptions,
  type PlacementProposalRow,
  type ProposalState,
  type StoredProposalItemKind
} from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import { NotFoundError, ValidationError } from '../errors'
import { isoDateTimeSchema } from '../validation'
import { DRAFT_THOUGHT_ID, proposePlacementPlan } from './placement/engine'
import type { PlacementPlan } from './placement/types'
import {
  countSkippedKinds,
  itemKey,
  mapPlan,
  pairFingerprint,
  proposalExpiry,
  toItemKey
} from './placement-proposals.mapping.service'
import type {
  EnqueueOutcome,
  EnqueuePlanOptions,
  EnqueueThoughtOptions,
  ListOptions,
  RejectOptions
} from './placement-proposals.types'
import {
  clampListLimit,
  resolveMaxProposalsPerEnqueue
} from './placement-proposals.helpers.service'

export { computeFingerprint, pairFingerprint } from './placement-proposals.mapping.service'
export type { FingerprintInput } from './placement-proposals.mapping.service'
export { isLegacyItemKind } from '../db/placement-proposals'
export type { PlacementProposalRow } from '../db/placement-proposals'

export type {
  EnqueueOutcome,
  EnqueuePlanOptions,
  EnqueueThoughtOptions,
  ListOptions,
  RejectOptions
} from './placement-proposals.types'

export function getProposalService(
  id: string,
  d: Database = getDb()
): PlacementProposalRow | undefined {
  return getProposal(d, id)
}

export function listAcceptedProposalsByRunService(
  runId: string,
  d: Database = getDb()
): PlacementProposalRow[] {
  return listAcceptedProposalsByRun(d, runId)
}

export function enqueuePlanService(
  plan: PlacementPlan,
  options: EnqueuePlanOptions = {},
  d: Database = getDb()
): EnqueueOutcome {
  const source = getThoughtRow(d, plan.thought_id)
  if (plan.thought_id === DRAFT_THOUGHT_ID || !source) {
    throw new ValidationError(
      'cannot enqueue proposals for a draft or unknown thought; persist the thought first'
    )
  }
  if (source.status !== 'active') {
    throw new ValidationError(
      `cannot enqueue placement proposals for '${source.status}' thought '${source.id}'; ` +
        'only a thought with status active participates in placement'
    )
  }

  const now = options.now ?? new Date().toISOString()
  const mapped = mapPlan(d, source, plan)
  const skipped = mapped.skipped.length
  const skippedKinds = countSkippedKinds(mapped.skipped)
  const items = mapped.items
  if (items.length === 0) return { proposals: [], skipped, skipped_kinds: skippedKinds }

  const maxPerEnqueue = resolveMaxProposalsPerEnqueue(options)
  const cappedItems = items.slice(0, maxPerEnqueue)
  if (cappedItems.length === 0) return { proposals: [], skipped, skipped_kinds: skippedKinds }

  const maxPending = config.placement.maxPendingProposals
  const expiresAt = proposalExpiry(now)
  const projectId = source.project_id ?? null

  const run = d.transaction(() => {
    const pending = listProposals(d, {
      state: 'pending',
      unexpired_at: now,
      limit: maxPending + cappedItems.length + 1
    })
    const keys = new Set(pending.map(toItemKey))
    let pendingCount = pending.length

    const rows: PlacementProposalRow[] = []
    for (const item of cappedItems) {
      const key = itemKey({
        sourceId: source.id,
        itemKind: item.itemKind,
        targetId: item.targetId,
        edgeType: item.edgeType,
        lifecycleAction: item.lifecycleAction
      })
      const isNew = !keys.has(key)
      if (isNew && pendingCount >= maxPending) {
        throw new ValidationError(
          `maximum ${maxPending} pending placement proposals reached; apply or reject existing items first`
        )
      }
      const input: InsertProposalInput = {
        project_id: projectId,
        source_thought_id: source.id,
        item_kind: item.itemKind,
        target_id: item.targetId,
        edge_type: item.edgeType,
        lifecycle_action: item.lifecycleAction,
        direction: item.direction,
        confidence: item.confidence,
        rationale: item.rationale,
        rule_id: item.ruleId,
        payload: item.payload,
        fingerprint: item.fingerprint,
        expires_at: expiresAt
      }
      rows.push(insertProposal(d, input))
      keys.add(key)
      if (isNew) pendingCount++
    }
    return rows
  })

  const rows = run()
  rows.sort(
    (a, b) =>
      String(a.item_kind).localeCompare(String(b.item_kind)) ||
      String(a.target_id ?? '').localeCompare(String(b.target_id ?? ''))
  )
  return { proposals: rows, skipped, skipped_kinds: skippedKinds }
}

export async function enqueueThoughtProposals(
  thoughtId: string,
  options: EnqueueThoughtOptions = {},
  d: Database = getDb()
): Promise<EnqueueOutcome> {
  const maxPerEnqueue = resolveMaxProposalsPerEnqueue(options)
  const plan = await proposePlacementPlan(
    { thoughtId, projectId: options.projectId },
    { projectId: options.projectId, now: options.now, maxProposals: maxPerEnqueue },
    {},
    d
  )
  return enqueuePlanService(plan, { now: options.now, maxProposals: maxPerEnqueue }, d)
}

export function listPlacementProposalsService(
  options: ListOptions = {},
  d: Database = getDb()
): PlacementProposalRow[] {
  return listProposals(d, {
    ...listFilterOptions(resolveListFilters(options)),
    limit: clampListLimit(options.limit)
  })
}

// Same filters as `listPlacementProposalsService`, counted in SQL: the page limit never caps it.
export function countPlacementProposalsService(
  options: ListOptions = {},
  d: Database = getDb()
): number {
  return countProposals(d, listFilterOptions(resolveListFilters(options)))
}

export interface PlacementProposalPage {
  items: PlacementProposalRow[]
  /** Un-paged rows matching the filters (the retired kinds excluded unless `includeRetired`). */
  total: number
  /** Retired (legacy) rows the default filter hid: in neither `total` nor the page. */
  hiddenRetired: number
}

// One read snapshot for the page, its total and the hidden retired count: separate statements could
// let a concurrent write move a row across the returned/filtered_out boundary. All three derive from
// one resolved filter set, so they also share one clock.
export function listPlacementProposalsPageService(
  options: ListOptions = {},
  d: Database = getDb()
): PlacementProposalPage {
  const filterOptions = listFilterOptions(resolveListFilters(options))
  return d.transaction(() => {
    const items = listProposals(d, { ...filterOptions, limit: clampListLimit(options.limit) })
    const total = countProposals(d, filterOptions)
    const withRetired = countProposals(d, { ...filterOptions, exclude_legacy: false })
    return { items, total, hiddenRetired: withRetired - total }
  })()
}

// Page and total must read the same set, or both `returned + filtered_out = total` and the page's
// fullness lie: a row dropped after LIMIT would consume a page slot.
function listFilterOptions(filters: ResolvedListFilters): ListProposalsOptions {
  return {
    state: filters.state,
    project_id: filters.projectId,
    item_kind: filters.itemKind,
    source_thought_id: filters.sourceThoughtId,
    created_after: filters.createdAfter,
    unexpired_at: filters.state === 'pending' ? filters.now : undefined,
    exclude_legacy: filters.itemKind === undefined && !filters.includeRetired
  }
}

interface ResolvedListFilters {
  state: ProposalState
  now: string
  projectId: string | undefined
  itemKind: StoredProposalItemKind | undefined
  sourceThoughtId: string | undefined
  createdAfter: string | undefined
  includeRetired: boolean
}

function resolveListFilters(options: ListOptions): ResolvedListFilters {
  const createdAfter = options.createdAfter ?? options.created_after
  if (createdAfter !== undefined && !isoDateTimeSchema.safeParse(createdAfter).success) {
    throw new ValidationError(
      `Invalid created_after: ${String(createdAfter)}. Must be a valid ISO timestamp.`
    )
  }
  return {
    state: options.state ?? 'pending',
    now: options.now ?? new Date().toISOString(),
    projectId: options.projectId ?? options.project_id,
    itemKind: options.itemKind ?? options.item_kind,
    sourceThoughtId: options.sourceThoughtId ?? options.source_thought_id,
    createdAfter,
    includeRetired: options.includeRetired ?? options.include_retired ?? false
  }
}

export function rejectPlacementProposalService(
  proposalId: string,
  options: RejectOptions = {},
  d: Database = getDb()
): PlacementProposalRow {
  const existing = getProposal(d, proposalId)
  if (!existing) throw new NotFoundError(`placement proposal '${proposalId}' not found`)
  if (existing.state !== 'pending') {
    throw new ValidationError(
      `placement proposal '${proposalId}' is '${existing.state}', not 'pending'`
    )
  }
  const updated = updateProposalState(d, proposalId, {
    state: 'rejected',
    decided_at: options.now ?? new Date().toISOString(),
    decided_by: options.decidedBy ?? null
  })
  if (!updated) throw new NotFoundError(`placement proposal '${proposalId}' not found`)
  return updated
}

export function isProposalStale(row: PlacementProposalRow, d: Database = getDb()): boolean {
  return pairFingerprint(d, row.source_thought_id, row.target_id) !== row.fingerprint
}
