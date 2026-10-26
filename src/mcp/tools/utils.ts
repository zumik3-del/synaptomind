import { z } from 'zod/v4'
import type { ChainResult } from '../../services/graph.service'
import { resolveProjectService } from '../../services/projects.service'

type McpTextContent = { type: 'text'; text: string }

/**
 * Declared output shape shared by every MCP tool. Tools multiplex several
 * actions with heterogeneous payloads, so the typed envelope keeps a single
 * stable contract: every successful result is `{ result: <payload> }`, where
 * the payload matches the JSON in `content[].text`.
 */
export const toolOutputShape = { result: z.unknown().describe('Action payload (structuredContent.result); JSON mirror of content[].text, except the raw-text config action, whose result is { item: { text }, meta }') }

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

export function resolveProjectId(cwd?: string): string | undefined {
  if (cwd) {
    const project = resolveProjectService(cwd)
    if (project) return project.id
    console.warn(`[scope] unknown cwd "${cwd}" — search will be global`)
  } else {
    console.warn('[scope] no project scope provided — search will be global')
  }
  return undefined
}

// ── Compact output mode plumbing ─────────────────────────────────────────────
// Shared, side-effect-free helpers for the opt-in `compact` + `fields` output
// controls. One resolveFields normalizes a field selection; one shapeThought
// transforms a thought; one projectFields projects an arbitrary object.

/** Minimal field set selected by `compact: true`. */
const COMPACT_FIELDS = ['id', 'content', 'status', 'tags', 'project'] as const

/** A single value accepted anywhere a field selection may appear. */
export type FieldSelectionInput =
  | boolean
  | string
  | string[]
  | Record<string, unknown>

interface ParsedFieldSelection {
  compact: boolean
  fields: string[] | undefined
  available: string[] | undefined
}

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

function parseFieldSelectionArgs(args: FieldSelectionInput[]): ParsedFieldSelection {
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
      for (const key of ['available', 'availableFields', 'availableColumns', 'columns', 'all', 'allFields', 'valid', 'validFields']) {
        if (obj[key] !== undefined) {
          available = toStringArray(obj[key])
          break
        }
      }
      if (obj.options !== undefined && obj.options !== null) {
        const nested = parseFieldSelectionArgs([obj.options as FieldSelectionInput])
        if (nested.compact) compact = true
        if (nested.fields !== undefined) fields = nested.fields
        if (nested.available !== undefined) available = nested.available
      }
    }
  }

  if (arrays.length >= 2) {
    if (fields === undefined) fields = arrays[0]
    if (available === undefined) available = arrays[1]
  } else if (arrays.length === 1) {
    const hasObject = args.some((a) => a !== null && typeof a === 'object' && !Array.isArray(a))
    if (hasObject) {
      if (fields === undefined) fields = arrays[0]
    } else {
      if (fields === undefined) fields = arrays[0]
    }
  }

  return { compact, fields, available }
}

function resolveFields(...args: FieldSelectionInput[]): string[] {
  const { compact, fields: rawFields, available } = parseFieldSelectionArgs(args)
  let fields = rawFields
  if (!fields || fields.length === 0) {
    fields = compact ? [...COMPACT_FIELDS] : available ? [...available] : []
  }
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

export function projectFields(...args: unknown[]): unknown {
  // Support projectFields(data, fields) and projectFields(fields, data).
  if (args.length >= 2) {
    const second = args[1]
    if (Array.isArray(second) || typeof second === 'string' || (second !== null && typeof second === 'object' && ('fields' in (second as Record<string, unknown>) || 'compact' in (second as Record<string, unknown>)))) {
      return projectFieldsImpl(args[0], args[1], ...args.slice(2))
    }
    if (Array.isArray(args[0]) || typeof args[0] === 'string') {
      return projectFieldsImpl(args[1], args[0], ...args.slice(2))
    }
  }
  return projectFieldsImpl(args[0])
}

function projectFieldsImpl(value: unknown, ...rest: unknown[]): unknown {
  let fields: string[] = []
  if (rest.length > 0) {
    const first = rest[0]
    if (Array.isArray(first) || typeof first === 'string' || (first !== null && typeof first === 'object')) {
      fields = resolveFields(first as FieldSelectionInput, ...(rest.slice(1) as FieldSelectionInput[]))
    }
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (obj.fields !== undefined || obj.compact !== undefined) {
      fields = resolveFields(obj as FieldSelectionInput)
    }
  }
  if (fields.length === 0 && rest.length === 0) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
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

/** Thought columns stored as SQLite 0/1 that the read surface exposes as booleans. */
const BOOLEAN_FIELDS = new Set(['is_protected', 'is_global', 'is_cluster'])

function toBoolean(value: unknown): boolean {
  return value === true || value === 1
}

/**
 * Read-surface hygiene for one thought column: tags become plain strings
 * (never `{ id, name }`) and the 0/1 flag columns become booleans, so a client
 * never has to know the storage encoding.
 */
function hygienicValue(field: string, value: unknown): unknown {
  if (field === 'tags') return stringifyTags(value)
  if (BOOLEAN_FIELDS.has(field)) return toBoolean(value)
  return value
}

/** Apply {@link hygienicValue} across a whole thought object (full output). */
function hygienicThought(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(t)) out[key] = hygienicValue(key, value)
  return out
}

/**
 * Shape one thought for the wire: `compact` trims to the minimal field set,
 * `fields` selects exactly the named columns, and both apply the read-surface
 * hygiene (tag names as strings, flag columns as booleans). An empty selection
 * returns the full thought with the same hygiene applied.
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
  const fieldList: string[] = requested.length > 0 ? [...requested] : (compactFlag ? [...COMPACT_FIELDS] : [])
  if (fieldList.length === 0) return hygienicThought(t)
  const out: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const f of fieldList) {
    if (seen.has(f)) continue
    seen.add(f)
    if (f === 'project') {
      out.project = t.project_name ?? t.project ?? t.project_id
    } else if (Object.hasOwn(t, f)) {
      out[f] = hygienicValue(f, t[f])
    }
  }
  return out
}

/**
 * Shape a thought chain (best_match neighbourhood) for compact/fields output.
 * Shared by the recall `context` and `get` handlers (DRY).
 */
export function shapeChain(chain: ChainResult | null | undefined, compact: boolean, fields: unknown): ChainResult | null | undefined {
  if (!chain) return chain
  return {
    ...chain,
    thought: chain.thought ? (shapeThought(chain.thought, compact, fields) as ChainResult['thought']) : chain.thought,
    upstream: Array.isArray(chain.upstream)
      ? chain.upstream.map((e) => ({ ...e, thought: e?.thought ? (shapeThought(e.thought, compact, fields) as typeof e.thought) : e?.thought }))
      : chain.upstream,
    downstream: Array.isArray(chain.downstream)
      ? chain.downstream.map((e) => ({ ...e, thought: e?.thought ? (shapeThought(e.thought, compact, fields) as typeof e.thought) : e?.thought }))
      : chain.downstream,
  }
}
