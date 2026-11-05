import { z } from 'zod/v4'
import type { ChainResult } from '../../services/graph.service'
import { resolveProjectService } from '../../services/projects.service'
import { getThoughtUrlLinksBatchService } from '../../services/url_links.service'

import { COMPACT_FIELDS } from './field-selection'
export * from './field-selection'
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
 *
 * `urlLinks` (opt-in, `include_url_links: true`) attaches the thought's url
 * links **after** the projection, so neither `compact` nor `fields` can hide a
 * surface the caller explicitly asked for (ADR §4 of the 0.20 HTTP shrink).
 */
export function shapeThought(
  thought: unknown,
  compact?: boolean,
  fields?: unknown,
  urlLinks?: BatchUrlLinks
): unknown {
  const shaped = projectThoughtShape(thought, compact, fields)
  if (urlLinks === undefined || !shaped || typeof shaped !== 'object' || Array.isArray(shaped)) return shaped
  return { ...(shaped as Record<string, unknown>), url_links: urlLinksOf(thought, urlLinks) }
}

/** {@link shapeThought} without the opt-in url-links surface. */
function projectThoughtShape(thought: unknown, compact?: boolean, fields?: unknown): unknown {
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
 * Shared by the recall `context` and `get` handlers (DRY). `urlLinks` reaches
 * every thought object in the result — the chain head and both neighbourhoods —
 * because "primary thought only" is a rule a caller cannot remember.
 */
export function shapeChain(
  chain: ChainResult | null | undefined,
  compact: boolean,
  fields: unknown,
  urlLinks?: BatchUrlLinks
): ChainResult | null | undefined {
  if (!chain) return chain
  return {
    ...chain,
    thought: chain.thought ? (shapeThought(chain.thought, compact, fields, urlLinks) as ChainResult['thought']) : chain.thought,
    upstream: Array.isArray(chain.upstream)
      ? chain.upstream.map((e) => ({ ...e, thought: e?.thought ? (shapeThought(e.thought, compact, fields, urlLinks) as typeof e.thought) : e?.thought }))
      : chain.upstream,
    downstream: Array.isArray(chain.downstream)
      ? chain.downstream.map((e) => ({ ...e, thought: e?.thought ? (shapeThought(e.thought, compact, fields, urlLinks) as typeof e.thought) : e?.thought }))
      : chain.downstream,
  }
}

// ── Opt-in url links (ADR §4 of the 0.20 HTTP shrink, task #2202) ────────────
// The removed `GET /api/thoughts/:id/links` read surface moved into the MCP
// thought output: one `include_url_links` flag per tool, default false. The
// links of a whole response are read in a single batch query (never per
// thought) and attached after `shapeThought`, so `compact` cannot hide them and
// `fields` cannot trim them.

/** One url link as the read surface emits it: `text` mirrors the create-time input. */
export interface UrlLinkView {
  text: string
  url: string
  label: string
}

/** Url links of one response, keyed by thought id. */
export type BatchUrlLinks = Map<string, UrlLinkView[]>

/**
 * Read the url links of every thought a response is about to emit, in one query.
 * Empty (`[]`) is attached later for a thought without links, so "asked and
 * there are none" stays distinguishable from "did not ask".
 */
export function loadUrlLinks(thoughts: ReadonlyArray<unknown>): BatchUrlLinks {
  const ids: string[] = []
  for (const thought of thoughts) {
    if (!thought || typeof thought !== 'object') continue
    const id = (thought as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  const byThought: BatchUrlLinks = new Map()
  if (ids.length === 0) return byThought
  for (const [thoughtId, rows] of Object.entries(getThoughtUrlLinksBatchService([...new Set(ids)]))) {
    byThought.set(thoughtId, rows.map((row) => ({ text: row.key, url: row.url, label: row.label })))
  }
  return byThought
}

/** The url links of one raw thought; `[]` when it has none. */
function urlLinksOf(thought: unknown, urlLinks: BatchUrlLinks): UrlLinkView[] {
  if (!thought || typeof thought !== 'object') return []
  const id = (thought as { id?: unknown }).id
  return typeof id === 'string' ? (urlLinks.get(id) ?? []) : []
}
