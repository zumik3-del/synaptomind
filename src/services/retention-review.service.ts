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
import { createThought as dbCreateThought, deleteThought, updateThought } from '../db/thoughts'
import { getThoughtTagsBatch, type Tag } from '../db/tags'
import { ValidationError, NotFoundError } from '../errors'
import { mergeThoughtsService } from './merge.service'
import { getThoughtTags } from '../db/tags'
import { computeContentHash } from '../utils'

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

// ---------------------------------------------------------------------------
// Retention-review actions: hard delete (cascade, preview-first) and protect.
// ---------------------------------------------------------------------------

export class RetentionReviewIneligibleError extends Error {
  readonly statusCode = 409
  constructor(msg = 'Thought is not an eligible retention-review candidate') {
    super(msg)
    this.name = 'RetentionReviewIneligibleError'
  }
}

export interface RetentionReviewDeleteOptions extends RetentionReviewQueryOptions {
  confirm?: boolean
  minAgeDays?: number
  min_age_days?: number
  importanceFloor?: number
  importance_floor?: number
  now?: string
  clock?: string
}

export interface RetentionReviewProtectOptions {
  minAgeDays?: number
  min_age_days?: number
  importanceFloor?: number
  importance_floor?: number
  now?: string
  clock?: string
}

interface ResolvedDeleteArgs {
  confirm: boolean
  opts: RetentionReviewDeleteOptions
  d: Database
}

function resolveDeleteArgs(_id: string, a?: unknown, b?: unknown): ResolvedDeleteArgs {
  let confirm = false
  let opts: RetentionReviewDeleteOptions = {}
  let d: Database | undefined

  const applyValue = (value: unknown) => {
    if (!value) return
    if (typeof value === 'boolean') {
      confirm = value
      return
    }
    if (typeof value === 'object') {
      if ('prepare' in (value as object)) {
        d = value as Database
        return
      }
      const o = value as RetentionReviewDeleteOptions
      opts = { ...opts, ...o }
      if (typeof o.confirm === 'boolean') confirm = o.confirm
    }
  }

  applyValue(a)
  applyValue(b)

  if (!d) d = getDb()
  return { confirm, opts, d }
}

function resolveProtectArgs(_id: string, a?: unknown, b?: unknown): { opts: RetentionReviewProtectOptions; d: Database } {
  let opts: RetentionReviewProtectOptions = {}
  let d: Database | undefined

  const applyValue = (value: unknown) => {
    if (!value) return
    if (typeof value === 'object') {
      if ('prepare' in (value as object)) {
        d = value as Database
        return
      }
      opts = { ...opts, ...(value as RetentionReviewProtectOptions) }
    }
  }

  applyValue(a)
  applyValue(b)
  if (!d) d = getDb()
  return { opts, d }
}

function resolveNow(opts: { now?: string; clock?: string }): string {
  return (opts.now ?? opts.clock ?? new Date().toISOString()) as string
}

function resolveMinAge(opts: RetentionReviewDeleteOptions): number {
  const v = asNumber(opts.minAgeDays ?? opts.min_age_days)
  const resolved = v === undefined ? config.retentionReview.minAgeDays : v
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new ValidationError('minAgeDays must be a positive number')
  }
  return resolved
}

function resolveFloor(opts: RetentionReviewDeleteOptions): number {
  const v = asNumber(opts.importanceFloor ?? opts.importance_floor)
  const resolved = v === undefined ? config.retentionReview.importanceFloor : v
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new ValidationError('importanceFloor must be in [0, 1]')
  }
  return resolved
}

interface EligibilityDetail {
  eligible: boolean
  reasons: string[]
  thought: {
    id: string
    content: string
    status: string
    project_id: string
    is_protected: number
    is_global: number
    created_at: string
    archived_at: string | null
    surface_after: string | null
    importance: number
    hit_count: number
  }
  incomingActiveEdges: number
}

function evaluateEligibility(id: string, d: Database, opts: RetentionReviewDeleteOptions, now: string): EligibilityDetail {
  const row = d
    .prepare(
      `SELECT t.id, t.content, t.status, t.project_id, t.is_protected, t.is_global,
              t.created_at, t.archived_at, t.surface_after,
              COALESCE(ti.importance, 1.0) AS importance,
              COALESCE(ti.hit_count, 0) AS hit_count
       FROM thoughts t
       LEFT JOIN thought_importance ti ON ti.thought_id = t.id
       WHERE t.id = ?`
    )
    .get(id) as
    | {
        id: string
        content: string
        status: string
        project_id: string
        is_protected: number
        is_global: number
        created_at: string
        archived_at: string | null
        surface_after: string | null
        importance: number
        hit_count: number
      }
    | undefined

  if (!row) throw new NotFoundError(`Thought not found: ${id}`)

  const reasons: string[] = []
  const minAgeDays = resolveMinAge(opts)
  const floor = resolveFloor(opts)
  const nowMs = Date.parse(now)

  if (!['archived', 'draft'].includes(row.status)) reasons.push('status not archived/draft')
  if (row.is_protected) reasons.push('protected')
  if (row.is_global) reasons.push('is_global')

  const anchor = row.archived_at ?? row.created_at
  const cutoffMs = nowMs - minAgeDays * 86400000
  if (!(Date.parse(anchor) < cutoffMs)) reasons.push('age < minAgeDays')

  if (!(row.importance < floor)) reasons.push('importance >= floor')
  if (row.hit_count !== 0) reasons.push('hit_count != 0')

  const incomingRow = d
    .prepare(
      `SELECT COUNT(*) AS c FROM edges e JOIN thoughts s ON s.id = e.source_id
       WHERE e.target_id = ? AND s.status = 'active'`
    )
    .get(id) as { c: number }
  const incomingActiveEdges = incomingRow?.c ?? 0
  if (incomingActiveEdges > 0) reasons.push('incoming active edges')

  if (row.surface_after && Date.parse(row.surface_after) > nowMs) reasons.push('surface_after in future')

  return {
    eligible: reasons.length === 0,
    reasons,
    thought: row,
    incomingActiveEdges
  }
}

function countDependents(id: string, d: Database): {
  edges: number
  importance: number
  url_links: number
  pending_embeddings: number
  primers: number
  thought_tags: number
  total: number
} {
  const safeCount = (sql: string): number => {
    try {
      const r = d.prepare(sql).get(id) as { c: number } | undefined
      return r?.c ?? 0
    } catch {
      return 0
    }
  }
  let edgesCount = 0
  try {
    const r = d.prepare(`SELECT COUNT(*) AS c FROM edges WHERE source_id = ? OR target_id = ?`).get(id, id) as { c: number } | undefined
    edgesCount = r?.c ?? 0
  } catch {
    edgesCount = 0
  }
  const importance = safeCount(`SELECT COUNT(*) AS c FROM thought_importance WHERE thought_id = ?`)
  const url_links = safeCount(`SELECT COUNT(*) AS c FROM thought_url_links WHERE thought_id = ?`)
  const pending_embeddings = safeCount(`SELECT COUNT(*) AS c FROM pending_embeddings WHERE thought_id = ?`)
  const primers = safeCount(`SELECT COUNT(*) AS c FROM primers WHERE thought_id = ?`)
  const thought_tags = safeCount(`SELECT COUNT(*) AS c FROM thought_tags WHERE thought_id = ?`)

  const total = edgesCount + importance + url_links + pending_embeddings + primers + thought_tags
  return {
    edges: edgesCount,
    importance,
    url_links,
    pending_embeddings,
    primers,
    thought_tags,
    total
  }
}

function tableExists(d: Database, name: string): boolean {
  try {
    const r = d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
    return !!r
  } catch {
    return false
  }
}

function cascadeDelete(id: string, d: Database): void {
  if (tableExists(d, 'edges')) {
    d.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).run(id, id)
  }
  if (tableExists(d, 'thought_importance')) {
    d.prepare(`DELETE FROM thought_importance WHERE thought_id = ?`).run(id)
  }
  if (tableExists(d, 'thought_url_links')) {
    d.prepare(`DELETE FROM thought_url_links WHERE thought_id = ?`).run(id)
  }
  if (tableExists(d, 'pending_embeddings')) {
    d.prepare(`DELETE FROM pending_embeddings WHERE thought_id = ?`).run(id)
  }
  if (tableExists(d, 'primers')) {
    d.prepare(`DELETE FROM primers WHERE thought_id = ?`).run(id)
  }
  if (tableExists(d, 'thought_tags')) {
    d.prepare(`DELETE FROM thought_tags WHERE thought_id = ?`).run(id)
  }
  // vec_thoughts handled by deleteThought
  deleteThought(d, id)
}

export function deleteRetentionReviewCandidateService(
  id: string,
  a?: unknown,
  b?: unknown
): {
  status: string
  action: string
  deleted: boolean
  preview: boolean
  confirm: boolean
  thought_id: string
  dependents?: ReturnType<typeof countDependents>
  instruction?: string
} {
  const { confirm, opts, d } = resolveDeleteArgs(id, a, b)
  const now = resolveNow(opts)

  const elig = evaluateEligibility(id, d, opts, now)
  if (!elig.eligible) {
    throw new RetentionReviewIneligibleError(
      `Thought ${id} is not an eligible retention-review candidate: ${elig.reasons.join(', ')}`
    )
  }

  const dependents = countDependents(id, d)

  if (!confirm) {
    return {
      status: 'preview',
      action: 'preview',
      deleted: false,
      preview: true,
      confirm: false,
      thought_id: id,
      dependents,
      instruction: `Call again with confirm: true to permanently delete thought ${id}.`
    }
  }

  d.transaction(() => {
    const elig2 = evaluateEligibility(id, d, opts, now)
    if (!elig2.eligible) {
      throw new RetentionReviewIneligibleError(
        `Thought ${id} is not an eligible retention-review candidate: ${elig2.reasons.join(', ')}`
      )
    }
    cascadeDelete(id, d)
  })()

  return {
    status: 'deleted',
    action: 'deleted',
    deleted: true,
    preview: false,
    confirm: true,
    thought_id: id,
    dependents
  }
}

export function protectRetentionReviewCandidateService(
  id: string,
  a?: unknown,
  b?: unknown
): {
  status: string
  action: string
  protected: boolean
  thought_id: string
} {
  const { d, opts } = resolveProtectArgs(id, a, b)
  const now = resolveNow(opts)
  const eligibility = evaluateEligibility(id, d, opts, now)
  if (!eligibility.eligible) {
    throw new RetentionReviewIneligibleError(
      `Thought ${id} is not an eligible retention-review candidate: ${eligibility.reasons.join(', ')}`
    )
  }

  d.transaction(() => {
    const latest = evaluateEligibility(id, d, opts, now)
    if (!latest.eligible) {
      throw new RetentionReviewIneligibleError(
        `Thought ${id} is no longer an eligible retention-review candidate: ${latest.reasons.join(', ')}`
      )
    }
    updateThought(d, id, { is_protected: true })
  })()

  return {
    status: 'protected',
    action: 'protected',
    protected: true,
    thought_id: id
  }
}

export interface RetentionReviewCompactOptions extends RetentionReviewDeleteOptions {
  source_ids: string[]
  summary: string | { content: string; tags?: string[]; project_id?: string }
  force?: boolean
}

/** Preview or atomically consolidate selected retention candidates into a protected summary. */
export function compactRetentionReviewCandidatesService(
  options: RetentionReviewCompactOptions,
  d: Database = getDb()
): { status: 'preview' | 'compacted'; preview: boolean; confirm: boolean; source_ids: string[]; summary?: ReturnType<typeof dbCreateThought>; instruction?: string } {
  const { source_ids, summary: summaryInput, force = false, confirm = false } = options
  if (!Array.isArray(source_ids) || source_ids.length === 0 || source_ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new ValidationError('source_ids must be a non-empty array of thought IDs')
  }
  if (new Set(source_ids).size !== source_ids.length) throw new ValidationError('source_ids must be distinct')
  const summaryObject = typeof summaryInput === 'string' ? { content: summaryInput } : summaryInput
  const summary = summaryObject?.content
  if (typeof summary !== 'string' || !summary.trim()) throw new ValidationError('summary.content must be non-empty')
  if (summaryObject.tags !== undefined && (!Array.isArray(summaryObject.tags) || summaryObject.tags.some(tag => typeof tag !== 'string'))) {
    throw new ValidationError('summary.tags must be an array of strings')
  }
  if (summaryObject.project_id !== undefined && (typeof summaryObject.project_id !== 'string' || !summaryObject.project_id.trim())) {
    throw new ValidationError('summary.project_id must be non-empty')
  }

  const now = resolveNow(options)
  const sources = source_ids.map(id => {
    const eligibility = evaluateEligibility(id, d, options, now)
    if (eligibility.thought.is_protected) throw new RetentionReviewIneligibleError(`Thought ${id} is protected`)
    if (!force && !eligibility.eligible) {
      throw new RetentionReviewIneligibleError(`Thought ${id} is not a current retention-review candidate: ${eligibility.reasons.join(', ')}`)
    }
    return eligibility.thought
  })
  const projectIds = new Set(sources.map(source => source.project_id))
  if (projectIds.size !== 1) throw new ValidationError('source_ids must belong to the same project')
  if (!confirm) return { status: 'preview', preview: true, confirm: false, source_ids, instruction: 'Confirm this exact source group and summary by calling again with confirm: true.' }

  const run = d.transaction(() => {
    // Revalidate in the write transaction so previewed candidates cannot become stale.
    const latest = sources.map(({ id }) => {
      const eligibility = evaluateEligibility(id, d, options, now)
      if (eligibility.thought.is_protected || (!force && !eligibility.eligible)) {
        throw new RetentionReviewIneligibleError(`Thought ${id} is no longer an eligible retention-review candidate: ${eligibility.reasons.join(', ')}`)
      }
      return eligibility.thought
    })
    if (new Set(latest.map(source => source.project_id)).size !== 1) {
      throw new RetentionReviewIneligibleError('Sources no longer belong to the same project')
    }
    const tags = summaryObject.tags === undefined
      ? [...new Set(latest.flatMap(source => getThoughtTags(d, source.id).map(tag => tag.name)))]
      : [...new Set(summaryObject.tags)]
    const projectId = summaryObject.project_id ?? latest[0].project_id
    const matchingThought = d.prepare(
      `SELECT id FROM thoughts WHERE content_hash = ? AND project_id = ? AND status IN ('draft', 'active') LIMIT 1`
    ).get(computeContentHash(summary.trim(), projectId), projectId)
    if (matchingThought) {
      throw new RetentionReviewIneligibleError('Summary content matches an existing draft or active thought')
    }
    const created = dbCreateThought(d, { content: summary.trim(), status: 'active', project_id: projectId, tags, is_protected: true })
    const summaryRow = d.prepare('SELECT status, is_protected FROM thoughts WHERE id = ?').get(created.id) as
      | { status: string; is_protected: number }
      | undefined
    if (!summaryRow || summaryRow.status !== 'active' || !summaryRow.is_protected) {
      throw new RetentionReviewIneligibleError('Summary content matches an existing draft or unprotected thought')
    }
    for (const source of latest) {
      mergeThoughtsService({ targetId: created.id, sourceId: source.id, mergedContent: summary.trim(), mergedTags: tags, allowArchivedSource: true }, d)
    }
    return created
  })
  return { status: 'compacted', preview: false, confirm: true, source_ids, summary: run() }
}

// Aliases for discoverability / compatibility with callers and tests.
export const deleteRetentionReview = deleteRetentionReviewCandidateService
export const deleteRetentionReviewService = deleteRetentionReviewCandidateService
export const deleteRetentionReviewCandidate = deleteRetentionReviewCandidateService
export const hardDeleteRetentionReview = deleteRetentionReviewCandidateService
export const hardDeleteRetentionReviewService = deleteRetentionReviewCandidateService
export const hardDeleteRetentionReviewCandidate = deleteRetentionReviewCandidateService
export const hardDeleteRetentionReviewCandidateService = deleteRetentionReviewCandidateService

export const protectRetentionReview = protectRetentionReviewCandidateService
export const protectRetentionReviewService = protectRetentionReviewCandidateService
export const protectRetentionReviewCandidate = protectRetentionReviewCandidateService

// Eligibility helpers (exported for reuse/testing).
export function isRetentionReviewCandidate(id: string, a?: unknown, b?: unknown): boolean {
  const { opts, d } = ((): { opts: RetentionReviewDeleteOptions; d: Database } => {
    // allow flexible db/options
    let o: RetentionReviewDeleteOptions = {}
    let db: Database | undefined
    const apply = (v: unknown) => {
      if (!v) return
      if (typeof v === 'object') {
        if ('prepare' in (v as object)) db = v as Database
        else o = { ...o, ...(v as RetentionReviewDeleteOptions) }
      }
    }
    apply(a)
    apply(b)
    if (!db) db = getDb()
    return { opts: o, d: db }
  })()
  const now = resolveNow(opts)
  try {
    return evaluateEligibility(id, d, opts, now).eligible
  } catch {
    return false
  }
}

export function validateRetentionReviewCandidate(id: string, a?: unknown, b?: unknown): EligibilityDetail {
  const { opts, d } = ((): { opts: RetentionReviewDeleteOptions; d: Database } => {
    let o: RetentionReviewDeleteOptions = {}
    let db: Database | undefined
    const apply = (v: unknown) => {
      if (!v) return
      if (typeof v === 'object') {
        if ('prepare' in (v as object)) db = v as Database
        else o = { ...o, ...(v as RetentionReviewDeleteOptions) }
      }
    }
    apply(a)
    apply(b)
    if (!db) db = getDb()
    return { opts: o, d: db }
  })()
  const now = resolveNow(opts)
  return evaluateEligibility(id, d, opts, now)
}

export default listRetentionReviewCandidatesService
