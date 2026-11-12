import type {
  PlacementProposalRow,
  ProposalState,
  StoredProposalItemKind
} from '../db/placement-proposals'

export interface EnqueueOutcome {
  proposals: PlacementProposalRow[]
  skipped: number
  skipped_kinds: Record<string, number>
}

export interface EnqueuePlanOptions {
  now?: string
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
  projectId?: string
  now?: string
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
  state?: ProposalState
  projectId?: string
  project_id?: string
  itemKind?: StoredProposalItemKind
  item_kind?: StoredProposalItemKind
  sourceThoughtId?: string
  source_thought_id?: string
  createdAfter?: string
  created_after?: string
  limit?: number
  now?: string
  includeRetired?: boolean
  include_retired?: boolean
}

export interface RejectOptions {
  decidedBy?: string
  now?: string
}
