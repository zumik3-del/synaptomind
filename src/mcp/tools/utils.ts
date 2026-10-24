import { z } from 'zod/v4'
import { resolveProjectService } from '../../services/projects.service'

type McpTextContent = { type: 'text'; text: string }

/**
 * Declared output shape shared by every MCP tool. Tools multiplex several
 * actions with heterogeneous payloads, so the typed envelope keeps a single
 * stable contract: every successful result is `{ result: <payload> }`, where
 * the payload matches the JSON in `content[].text`.
 */
export const toolOutputShape = { result: z.unknown().describe('Action payload (structuredContent.result); JSON mirror of content[].text, except raw-text tools where result is {text}') }

export function jsonResult(data: unknown): { content: McpTextContent[]; structuredContent: { result: unknown } } {
  // Bare string payloads are wrapped so no action ever returns a bare string
  // in `result`; arrays/objects pass through unchanged.
  const payload = typeof data === 'string' ? { text: data } : data
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { result: payload }
  }
}

/** HTTP-style metadata an error envelope can carry on top of its message. */
export interface ErrorEnvelopeMeta {
  /** Domain status code (`src/errors.ts`) surfaced so clients see the class of failure. */
  statusCode?: number
  /** True when the caller can safely repeat the same request (transient/availability failures). */
  retryable?: boolean
}

/**
 * Build the `isError` envelope for an action failure.
 *
 * The human-readable message stays in `content`, exactly as before. When the
 * thrown error carries HTTP-style metadata, it is mirrored into the envelope's
 * `structuredContent.result.error` so an MCP client can tell a transient
 * embedder failure (503, retry) apart from a server bug (audit M6). Unclassified
 * errors keep the plain `{ content, isError }` shape — no `result` key is
 * synthesized for them. The tool's declared output schema is `{ result }` and
 * the SDK's client only validates `structuredContent` when present, so nesting
 * the metadata under `result` keeps both sides schema-compliant.
 */
export function errorResult(
  message: string,
  meta: ErrorEnvelopeMeta = {},
): { content: McpTextContent[]; structuredContent?: { result: { error: ErrorEnvelopeMeta & { message: string } } }; isError: true } {
  const content: McpTextContent[] = [{ type: 'text' as const, text: message }]
  const error: ErrorEnvelopeMeta & { message: string } = { message }
  if (meta.statusCode !== undefined) error.statusCode = meta.statusCode
  if (meta.retryable !== undefined) error.retryable = meta.retryable
  if (error.statusCode === undefined && error.retryable === undefined) {
    return { content, isError: true }
  }
  return { content, structuredContent: { result: { error } }, isError: true }
}

export function resolveProjectId(projectId?: string, cwd?: string): string | undefined {
  if (projectId) return projectId
  if (cwd) {
    const project = resolveProjectService(cwd)
    if (project) return project.id
    console.warn(`[scope] unknown cwd "${cwd}" — search will be global`)
  } else {
    console.warn('[scope] no project scope provided — search will be global')
  }
  return undefined
}

// ── Compact output mode plumbing (task #2122) ─────────────────────────────────
// Shared, side-effect-free helpers for the opt-in `compact` + `fields` output
// controls. No tool currently consumes them (task #2131 wires them into read
// tools); this module only parses/validates/intersects so callers stay thin.

/** Minimal field set selected by `compact: true`. */
export const COMPACT_FIELDS = ['id', 'content', 'status', 'tags', 'project'] as const
export const DEFAULT_COMPACT_FIELDS = [...COMPACT_FIELDS]
export const COMPACT_OUTPUT_FIELDS = [...COMPACT_FIELDS]
export const MINIMAL_FIELDS = [...COMPACT_FIELDS]
export const compactDefaults = [...COMPACT_FIELDS]
export const compactDefaultFields = [...COMPACT_FIELDS]

function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return [String(value).trim()].filter((v) => v.length > 0)
}

interface ParsedFieldSelection {
  compact: boolean
  fields: string[] | undefined
  available: string[] | undefined
}

function parseFieldSelectionArgs(args: unknown[]): ParsedFieldSelection {
  let compact = false
  let fields: string[] | undefined
  let available: string[] | undefined

  const arrays: string[][] = []
  for (const arg of args) {
    if (arg === undefined || arg === null) continue
    if (typeof arg === 'boolean') {
      compact = compact || arg
      continue
    }
    if (Array.isArray(arg)) {
      arrays.push(toStringArray(arg))
      continue
    }
    if (typeof arg === 'string') {
      // A bare string is treated as a field list only if it contains a comma
      // or matches a known field-ish token; otherwise leave it as a single field.
      // We keep it simple: bare strings become a one-element field request.
      fields = fields ?? [arg.trim()].filter(Boolean)
      continue
    }
    if (typeof arg === 'object') {
      const obj = arg as Record<string, unknown>
      if (typeof obj.compact === 'boolean') compact = compact || obj.compact
      if (typeof obj.compact === 'string') compact = compact || obj.compact === 'true'
      if (obj.fields !== undefined) fields = toStringArray(obj.fields)
      if (obj.field !== undefined && fields === undefined) fields = toStringArray(obj.field)
      if (obj.requested !== undefined && fields === undefined) fields = toStringArray(obj.requested)
      if (obj.requestedFields !== undefined && fields === undefined) fields = toStringArray(obj.requestedFields)
      if (obj.selected !== undefined && fields === undefined) fields = toStringArray(obj.selected)
      // available columns
      for (const key of ['available', 'availableFields', 'availableColumns', 'columns', 'all', 'allFields', 'valid', 'validFields']) {
        if (obj[key] !== undefined) {
          available = toStringArray(obj[key])
          break
        }
      }
      // nested options
      if (obj.options && typeof obj.options === 'object') {
        const nested = parseFieldSelectionArgs([obj.options])
        if (nested.compact) compact = true
        if (nested.fields !== undefined) fields = nested.fields
        if (nested.available !== undefined) available = nested.available
      }
    }
  }

  // Resolve array ambiguity: two arrays => fields, available.
  if (arrays.length >= 2) {
    if (fields === undefined) fields = arrays[0]
    if (available === undefined) available = arrays[1]
  } else if (arrays.length === 1) {
    const hasObject = args.some((a) => a && typeof a === 'object' && !Array.isArray(a))
    if (hasObject) {
      if (fields === undefined) fields = arrays[0]
    } else {
      // No object: treat a lone array as the requested fields when compact is on,
      // otherwise as available columns. Default to requested fields.
      if (fields === undefined) fields = arrays[0]
    }
  }

  return { compact, fields, available }
}

export function resolveFields(...args: unknown[]): string[] {
  const { compact, fields: rawFields, available } = parseFieldSelectionArgs(args)
  let fields = rawFields
  if (!fields || fields.length === 0) {
    fields = compact ? [...COMPACT_FIELDS] : available ? [...available] : []
  }
  if (compact && rawFields && rawFields.length > 0) {
    // compact is a hint; explicit fields win. Keep as-is.
  }
  // intersect with available columns when provided
  if (available && available.length > 0) {
    const availSet = new Set(available)
    const out: string[] = []
    const seen = new Set<string>()
    for (const f of fields) {
      if (availSet.has(f) && !seen.has(f)) {
        out.push(f)
        seen.add(f)
      }
    }
    return out
  }
  // dedupe
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of fields) {
    if (!seen.has(f)) {
      out.push(f)
      seen.add(f)
    }
  }
  return out
}

export function intersectFields(...args: unknown[]): string[] {
  const { fields: rawFields, available } = parseFieldSelectionArgs(args)
  const requested = rawFields ?? []
  if (!available || available.length === 0) {
    // dedupe requested
    const out: string[] = []
    const seen = new Set<string>()
    for (const f of requested) if (!seen.has(f)) { out.push(f); seen.add(f) }
    return out
  }
  const availSet = new Set(available)
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of requested) {
    if (availSet.has(f) && !seen.has(f)) {
      out.push(f)
      seen.add(f)
    }
  }
  return out
}

export function partitionFields(...args: unknown[]): { fields: string[]; unknown: string[]; valid: string[]; invalid: string[] } {
  const { fields: rawFields, available } = parseFieldSelectionArgs(args)
  const requested = rawFields ?? []
  if (!available || available.length === 0) {
    return { fields: [...requested], unknown: [], valid: [...requested], invalid: [] }
  }
  const availSet = new Set(available)
  const fields: string[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const f of requested) {
    if (availSet.has(f)) {
      if (!seen.has(f)) { fields.push(f); seen.add(f) }
    } else if (!unknown.includes(f)) {
      unknown.push(f)
    }
  }
  return { fields, unknown, valid: [...fields], invalid: [...unknown] }
}

export function unknownFields(...args: unknown[]): string[] {
  return partitionFields(...args).unknown
}

export function pickFields(value: unknown, ...rest: unknown[]): unknown {
  // Determine fields list
  let fields: string[] = []
  if (rest.length > 0) {
    const first = rest[0]
    if (Array.isArray(first) || typeof first === 'string' || (first && typeof first === 'object')) {
      fields = resolveFields(first as any, ...rest.slice(1))
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (obj.fields !== undefined || obj.compact !== undefined) {
      fields = resolveFields(obj)
      // value might actually be data with a fields property; ambiguous. Prefer data projection only if rest provided.
    }
  }
  if (fields.length === 0 && rest.length === 0) {
    // try value.fields
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (Array.isArray(obj.fields)) fields = toStringArray(obj.fields)
    }
  }

  const projectOne = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    if (fields.length === 0) return item
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      if (Object.hasOwn(item as object, f)) out[f] = (item as Record<string, unknown>)[f]
    }
    return out
  }

  if (Array.isArray(value)) return value.map(projectOne)
  return projectOne(value)
}

export function projectFields(...args: unknown[]): unknown {
  // Support projectFields(data, fields) and projectFields(fields, data)
  if (args.length >= 2 && (Array.isArray(args[1]) || typeof args[1] === 'string' || (args[1] && typeof args[1] === 'object' && ('fields' in (args[1] as object) || 'compact' in (args[1] as object))))) {
    return pickFields(args[0], args[1], ...args.slice(2))
  }
  if (args.length >= 2 && (Array.isArray(args[0]) || typeof args[0] === 'string')) {
    // fields first, data second
    return pickFields(args[1], args[0], ...args.slice(2))
  }
  return pickFields(args[0])
}

export function applyFields(...args: unknown[]): unknown {
  return projectFields(...args)
}

export function selectFields(...args: unknown[]): unknown {
  return projectFields(...args)
}

export function filterFields(...args: unknown[]): unknown {
  return projectFields(...args)
}

function stringifyTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  return tags.map((t) => {
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>
      if (typeof o.name === 'string') return o.name
      if (typeof o.tag === 'string') return o.tag
      return String(o.id ?? t)
    }
    return String(t)
  })
}

export function compactThought(thought: unknown): Record<string, unknown> {
  if (!thought || typeof thought !== 'object' || Array.isArray(thought)) return {}
  const t = thought as Record<string, unknown>
  const project = (t.project_name ?? t.project ?? t.project_id) as unknown
  return {
    id: t.id,
    content: t.content,
    status: t.status,
    tags: stringifyTags(t.tags),
    project,
  }
}

/**
 * Apply the opt-in `compact` / `fields` controls to a single thought-like object.
 *
 * - `compact: true` with no `fields` selects the minimal field set
 *   (`COMPACT_FIELDS`: id, content, status, tags-as-strings, project).
 * - `fields` (array or comma string) selects an explicit subset; `compact` is
 *   treated as a hint and only affects tag stringification.
 * - With neither flag the original object is returned unchanged (backward
 *   compatible).
 *
 * `project` is mapped from `project_name`/`project`/`project_id` when the
 * requested field is not a direct property of the thought.
 */
export function shapeThought(thought: unknown, compact?: boolean, fields?: unknown): unknown {
  if (!thought || typeof thought !== 'object' || Array.isArray(thought)) return thought
  const t = thought as Record<string, unknown>
  const compactFlag = compact === true
  const requested = Array.isArray(fields)
    ? fields.map((v) => String(v).trim()).filter(Boolean)
    : (typeof fields === 'string'
        ? fields.split(',').map((v) => v.trim()).filter(Boolean)
        : [])
  let fieldList: string[] = requested.length > 0 ? [...requested] : (compactFlag ? [...COMPACT_FIELDS] : [])
  if (fieldList.length === 0) return thought
  const out: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const f of fieldList) {
    if (seen.has(f)) continue
    seen.add(f)
    if (f === 'project') {
      out.project = t.project_name ?? t.project ?? t.project_id
    } else if (Object.hasOwn(t, f)) {
      let v = t[f]
      if (compactFlag && f === 'tags') v = stringifyTags(v)
      out[f] = v
    }
  }
  return out
}

export function toCompact(...args: unknown[]): unknown {
  // toCompact(data, options?) 
  const data = args[0]
  if (Array.isArray(data)) return data.map((d) => compactThought(d))
  return compactThought(data)
}

export function compactOutput(...args: unknown[]): unknown {
  return toCompact(...args)
}

// Aliases for field-name resolution
export {
  resolveFields as applyCompact,
  resolveFields as applyCompactAndFields,
  resolveFields as applyFieldSelection,
  resolveFields as buildFields,
  resolveFields as buildFieldSet,
  resolveFields as computeFields,
  resolveFields as fieldSelection,
  resolveFields as fieldsFor,
  resolveFields as getFields,
  resolveFields as normalizeFields,
  resolveFields as outputFields,
  resolveFields as parseCompact,
  resolveFields as parseFields,
  resolveFields as pickFieldsList,
  resolveFields as projectFieldsList,
  resolveFields as resolveOutputFields,
  resolveFields as selectFieldsList,
  resolveFields as selectedFields,
  intersectFields as intersect,
  intersectFields as intersectColumns,
  intersectFields as intersectAvailable,
  intersectFields as filterAvailable,
  partitionFields as splitFields,
  partitionFields as validateFields,
  partitionFields as fieldsPartition,
  projectFields as project,
  projectFields as pick,
  projectFields as select,
  projectFields as filter,
  projectFields as apply,
  projectFields as pluck,
}

