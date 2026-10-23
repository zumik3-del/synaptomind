/**
 * Retention-review candidate query (ADR 2026-10-23 "Retention Review").
 *
 * Surfaces individual archived/draft thoughts that carry all of the "probably
 * trash" signals so a human can decide per candidate among delete / protect /
 * keep / compact. Read-only: this module selects and counts only; mutating
 * actions live in the follow-up tasks (#2067, #2068).
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { getThoughtTagsBatch, type Tag } from '../db/tags'
import { ValidationError } from '../errors'

export interface RetentionReviewCandidate {
  id: string
  /** Content truncated to 200 characters. */
  content: string
  status: string
  project_id: string
  project_name: string | null
  created_at: string
  archived_at: string | null
  /** Whole days between the age anchor and `now`. */
  age_days: number
  importance: number
  hit_count: number
  tags: Tag[]
}

export interface RetentionReviewQueryOptions {
  minAgeDays?: number
  min_age_days?: number
  importanceFloor?: number
  importance_floor?: number
  limit?: number
  offset?: number
  pageSize?: number
  page_size?: number
  /** Clock override (ISO-8601) for deterministic tests. */
  now?: string
  clock?: string
}

export interface RetentionReviewResult {
  total: number
  limit: number
  offset: number
  candidates: RetentionReviewCandidate[]
}

type LooseOptions = RetentionReviewQueryOptions & Record<string, unknown>

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function resolveDb(a: unknown, b: unknown): Database {
  if (a && typeof a === 'object' && 'prepare' in (a as object)) return a as Database
  if (b && typeof b === 'object' && 'prepare' in (b as object)) return b as Database
  return getDb()
}

function resolveOptions(a: unknown, b: unknown): LooseOptions {
  if (a && typeof a === 'object' && !('prepare' in (a as object))) return a as LooseOptions
  if (b && typeof b === 'object' && !('prepare' in (b as object))) return b as LooseOptions
  return {}
}

const CONTENT_TRUNCATE = 200

function truncate(content: string): string {
  return content.length > CONTENT_TRUNCATE ? content.slice(0, CONTENT_TRUNCATE) : content
}

/**
 * Paginated retention-review candidate query.
 *
 * A thought is a candidate iff all of the following hold:
 *   - status is `archived` or `draft`
 *   - age anchor `COALESCE(archived_at, created_at)` is older than `minAgeDays`
 *   - importance (missing row => 1.0) < `importanceFloor`
 *   - hit_count (missing row => 0) == 0
 *   - no incoming edge whose source thought is `active`
 *   - is_protected = 0
 *   - surface_after is NULL or not in the future
 *   - is_global = 0
 *
 * Ordering: age anchor ascending, then id ascending. Response carries `total`
 * (same filters, ignoring paging), `limit`, `offset` and `candidates`.
 */
export function listRetentionReviewCandidatesService(
  optionsOrDb?: RetentionReviewQueryOptions | Database,
  dbOrOptions?: Database | RetentionReviewQueryOptions
): RetentionReviewResult {
  const d = resolveDb(optionsOrDb, dbOrOptions)
  const opts = resolveOptions(optionsOrDb, dbOrOptions)

  const now = (opts.now ?? opts.clock ?? new Date().toISOString()) as string
  const nowMs = Date.parse(now)

  const minAgeDays = asNumber(opts.minAgeDays ?? opts.min_age_days)
  const resolvedMinAge = minAgeDays === undefined ? config.retentionReview.minAgeDays : minAgeDays
  if (!Number.isFinite(resolvedMinAge) || resolvedMinAge <= 0) {
    throw new ValidationError('minAgeDays must be a positive number')
  }

  const importanceFloor = asNumber(opts.importanceFloor ?? opts.importance_floor)
  const resolvedFloor = importanceFloor === undefined ? config.retentionReview.importanceFloor : importanceFloor
  if (!Number.isFinite(resolvedFloor) || resolvedFloor < 0 || resolvedFloor > 1) {
    throw new ValidationError('importanceFloor must be in [0, 1]')
  }

  const limitRaw = asNumber(opts.limit ?? opts.pageSize ?? opts.page_size)
  const resolvedLimit = limitRaw === undefined ? config.retentionReview.pageSize : Math.floor(limitRaw)
  if (!Number.isFinite(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 100) {
    throw new ValidationError('limit must be between 1 and 100')
  }

  const offsetRaw = asNumber(opts.offset)
  const resolvedOffset = offsetRaw === undefined ? 0 : Math.floor(offsetRaw)
  if (!Number.isFinite(resolvedOffset) || resolvedOffset < 0) {
    throw new ValidationError('offset must be >= 0')
  }

  const cutoff = new Date(nowMs - resolvedMinAge * 86400000).toISOString()

  const where = `
    WHERE t.status IN ('archived', 'draft')
      AND COALESCE(t.archived_at, t.created_at) < ?
      AND COALESCE(ti.importance, 1.0) < ?
      AND COALESCE(ti.hit_count, 0) = 0
      AND t.is_protected = 0
      AND (t.surface_after IS NULL OR t.surface_after <= ?)
      AND COALESCE(t.is_global, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN thoughts s ON s.id = e.source_id
        WHERE e.target_id = t.id AND s.status = 'active'
      )
  `

  const countSql = `
    SELECT COUNT(*) AS total
    FROM thoughts t
    LEFT JOIN thought_importance ti ON ti.thought_id = t.id
    ${where}
  `
  const totalRow = d.prepare(countSql).get(cutoff, resolvedFloor, now) as { total: number } | undefined
  const total = totalRow?.total ?? 0

  const listSql = `
    SELECT t.id, t.content, t.status, t.project_id, p.name AS project_name,
           t.created_at, t.archived_at, t.surface_after,
           COALESCE(ti.importance, 1.0) AS importance,
           COALESCE(ti.hit_count, 0) AS hit_count
    FROM thoughts t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN thought_importance ti ON ti.thought_id = t.id
    ${where}
    ORDER BY COALESCE(t.archived_at, t.created_at) ASC, t.id ASC
    LIMIT ? OFFSET ?
  `
  const rows = d
    .prepare(listSql)
    .all(cutoff, resolvedFloor, now, resolvedLimit, resolvedOffset) as Array<{
    id: string
    content: string
    status: string
    project_id: string
    project_name: string | null
    created_at: string
    archived_at: string | null
    surface_after: string | null
    importance: number
    hit_count: number
  }>

  const tagMap = getThoughtTagsBatch(d, rows.map(r => r.id))

  const candidates: RetentionReviewCandidate[] = rows.map(r => {
    const anchor = r.archived_at ?? r.created_at
    const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(anchor)) / 86400000))
    return {
      id: r.id,
      content: truncate(r.content),
      status: r.status,
      project_id: r.project_id,
      project_name: r.project_name,
      created_at: r.created_at,
      archived_at: r.archived_at,
      age_days: ageDays,
      importance: r.importance,
      hit_count: r.hit_count,
      tags: tagMap.get(r.id) ?? []
    }
  })

  return { total, limit: resolvedLimit, offset: resolvedOffset, candidates }
}

// Aliases for discoverability / compatibility with callers and tests.
export const listRetentionReviewCandidates = listRetentionReviewCandidatesService
export const getRetentionReviewCandidates = listRetentionReviewCandidatesService
export const getRetentionReviewCandidatesService = listRetentionReviewCandidatesService
export const listRetentionReview = listRetentionReviewCandidatesService
export const listRetentionReviewService = listRetentionReviewCandidatesService
export const findRetentionReviewCandidates = listRetentionReviewCandidatesService
export const findRetentionReviewCandidatesService = listRetentionReviewCandidatesService
export const retentionReviewCandidates = listRetentionReviewCandidatesService

export const retentionReviewCandidatesService = listRetentionReviewCandidatesService
export const retentionReviewCandidateQuery = listRetentionReviewCandidatesService
export const getRetentionReviewCandidateQuery = listRetentionReviewCandidatesService
export const listRetentionReviewCandidateQuery = listRetentionReviewCandidatesService
export const queryRetentionReviewCandidates = listRetentionReviewCandidatesService
export const retentionReviewQuery = listRetentionReviewCandidatesService

export default listRetentionReviewCandidatesService
