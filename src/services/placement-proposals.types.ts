import type { PlacementProposalRow, ProposalState, StoredProposalItemKind } from '../db/placement-proposals'

/**
 * The result of one enqueue: the queued rows plus what was *not* queued.
 * `skipped` counts the plan items whose kind the queue no longer supports
 * (task #1942) — `placement` and `lifecycle` — so nothing is lost silently.
 */
export interface EnqueueOutcome {
  /** The queued rows — `edge` items only (task #1942). */
  proposals: PlacementProposalRow[]
  /** How many plan items were not queued because their kind is no longer supported. */
  skipped: number
  /** The skipped kinds and how many of each (`placement`, `lifecycle`). */
  skipped_kinds: Record<string, number>
}

export interface EnqueuePlanOptions {
  /** Clock override for deterministic tests (default now). */
  now?: string
  /** Cap on the number of proposals enqueued for this plan (default config.placement.maxProposalsPerEnqueue). */
  maxProposals?: number
  max_proposals?: number
  maxItems?: number
  max_items?: number
  maxItemsPerEnqueue?: number
  max_items_per_enqueue?: number
  maxProposalsPerEnqueue?: number
  max_proposals_per_enqueue?: number
  limit?: number
}

export interface EnqueueThoughtOptions {
  /** Project scope for neighbour recall (defaults to the thought's project). */
  projectId?: string
  /** Clock override for deterministic tests (default now). */
  now?: string
  /** Cap on the number of proposals enqueued for this thought (default config.placement.maxProposalsPerEnqueue). */
  maxProposals?: number
  max_proposals?: number
  maxItems?: number
  max_items?: number
  maxItemsPerEnqueue?: number
  max_items_per_enqueue?: number
  maxProposalsPerEnqueue?: number
  max_proposals_per_enqueue?: number
  limit?: number
}

export interface ListOptions {
  /** State filter; defaults to live `pending` rows (ADR §2.2). */
  state?: ProposalState
  projectId?: string
  project_id?: string
  /** Optional item-kind filter; a removed kind still filters (tasks #1942, #1946). */
  itemKind?: StoredProposalItemKind
  item_kind?: StoredProposalItemKind
  /** Optional source-thought filter (queued proposals of one source thought). */
  sourceThoughtId?: string
  source_thought_id?: string
  /** Optional lower bound on created_at (ISO; inclusive). */
  createdAfter?: string
  created_after?: string
  limit?: number
  /** Clock override for the expired-row filter (default now). */
  now?: string
  /** When true, retired (legacy) kinds are included even without an explicit item_kind. */
  includeRetired?: boolean
  include_retired?: boolean
}

export interface RejectOptions {
  /** Agent/tool that rejected the item (audit, ADR §2.8). */
  decidedBy?: string
  now?: string
}
