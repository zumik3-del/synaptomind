import { ValidationError } from '../errors'
import type { ContradictionMode, SearchServiceOptions, SupersessionMode } from './search.service'

export const SUPERSESSION_MODES: readonly SupersessionMode[] = ['off', 'flag', 'suppress']
export const CONTRADICTION_MODES: readonly ContradictionMode[] = ['off', 'flag']

/**
 * Agent-facing default for superseded thoughts is `suppress` (the library
 * default stays `flag`); an explicit but unknown value is a 400.
 */
export const DEFAULT_SUPERSESSION_MODE: SupersessionMode = 'suppress'
export const DEFAULT_CONTRADICTION_MODE: ContradictionMode = 'flag'

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

/**
 * Parse an optional numeric query parameter. An absent/empty value is
 * `undefined`; a present but unparseable value is a 400 (`ValidationError`).
 * Out-of-range finite values are left to the service clamps.
 */
export function parseOptionalNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) throw new ValidationError(`invalid ${name} '${raw}'; expected a number`)
  return value
}

/**
 * Already-parsed search inputs shared by the HTTP API and the MCP tool.
 * Surface-specific extraction (query presence, `k` parsing, cluster string
 * flags, project resolution) stays at the call site.
 */
export interface SearchOptionsParams {
  query: string
  topK: number
  status?: string
  projectFilter?: string
  tagFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  excludeFlagged?: boolean
  includeGlobal?: boolean
  hybrid?: boolean
  supersessionMode?: SupersessionMode
  contradictionMode?: ContradictionMode
  recencyWeight?: number
  recencyHalfLifeDays?: number
  minRelevance?: number
}

/**
 * Assemble the shared `SearchServiceOptions` from parsed inputs. The `status`
 * default and the field mapping live here; standing modes pass through
 * untouched so callers that omit them keep the library defaults (`flag`).
 */
export function buildSearchOptions(params: SearchOptionsParams): SearchServiceOptions {
  return {
    query: params.query,
    topK: params.topK,
    statusFilter: params.status || 'active',
    projectFilter: params.projectFilter,
    tagFilter: params.tagFilter,
    clusterFilter: params.clusterFilter,
    minImportance: params.minImportance,
    excludeFlagged: params.excludeFlagged,
    includeGlobal: params.includeGlobal,
    hybrid: params.hybrid,
    supersessionMode: params.supersessionMode,
    contradictionMode: params.contradictionMode,
    recencyWeight: params.recencyWeight,
    recencyHalfLifeDays: params.recencyHalfLifeDays,
    minRelevance: params.minRelevance
  }
}
