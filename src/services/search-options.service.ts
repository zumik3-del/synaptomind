import { ValidationError } from '../errors'
import type { ContradictionMode, SearchServiceOptions, SupersessionMode } from './search.service'

const SUPERSESSION_MODES: readonly SupersessionMode[] = ['off', 'flag', 'suppress']
const CONTRADICTION_MODES: readonly ContradictionMode[] = ['off', 'flag']

// The agent-facing default is `suppress`, while the library default stays `flag`.
const DEFAULT_SUPERSESSION_MODE: SupersessionMode = 'suppress'
const DEFAULT_CONTRADICTION_MODE: ContradictionMode = 'flag'

export function parseSupersessionMode(raw: string | undefined): SupersessionMode {
  if (raw === undefined || raw === '') return DEFAULT_SUPERSESSION_MODE
  if ((SUPERSESSION_MODES as readonly string[]).includes(raw)) return raw as SupersessionMode
  throw new ValidationError(`invalid supersession_mode '${raw}'; expected off|flag|suppress`)
}

export function parseContradictionMode(raw: string | undefined): ContradictionMode {
  if (raw === undefined || raw === '') return DEFAULT_CONTRADICTION_MODE
  if ((CONTRADICTION_MODES as readonly string[]).includes(raw)) return raw as ContradictionMode
  throw new ValidationError(`invalid contradiction_mode '${raw}'; expected off|flag`)
}

export function parseOptionalNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value))
    throw new ValidationError(`invalid ${name} '${raw}'; expected a number`)
  return value
}

export interface SearchOptionsParams {
  query: string
  topK: number
  status?: string
  projectFilter?: string
  tagFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  hybrid?: boolean
  supersessionMode?: SupersessionMode
  contradictionMode?: ContradictionMode
  recencyWeight?: number
  recencyHalfLifeDays?: number
  minRelevance?: number
}

export function buildSearchOptions(params: SearchOptionsParams): SearchServiceOptions {
  return {
    query: params.query,
    topK: params.topK,
    statusFilter: params.status || 'active',
    projectFilter: params.projectFilter,
    tagFilter: params.tagFilter,
    clusterFilter: params.clusterFilter,
    minImportance: params.minImportance,
    hybrid: params.hybrid,
    supersessionMode: params.supersessionMode,
    contradictionMode: params.contradictionMode,
    recencyWeight: params.recencyWeight,
    recencyHalfLifeDays: params.recencyHalfLifeDays,
    minRelevance: params.minRelevance
  }
}
