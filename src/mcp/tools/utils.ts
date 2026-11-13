import { z } from 'zod/v4'
import type { ChainResult } from '../../services/graph.service'
import { resolveProjectService } from '../../services/projects.service'
import { getThoughtUrlLinksBatchService } from '../../services/url_links.service'

import { COMPACT_FIELDS } from './field-selection'
export * from './field-selection'
type McpTextContent = { type: 'text'; text: string }

export const toolOutputShape = {
  result: z
    .unknown()
    .describe(
      'Action payload (structuredContent.result); JSON mirror of content[].text, except the raw-text config action, whose result is { item: { text }, meta }'
    )
}

export function jsonResult(data: unknown): {
  content: McpTextContent[]
  structuredContent: { result: unknown }
} {
  const payload = typeof data === 'string' ? { text: data } : data
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { result: payload }
  }
}

export interface ErrorEnvelopeMeta {
  statusCode?: number
  retryable?: boolean
}

export function errorResult(
  message: string,
  meta: ErrorEnvelopeMeta = {}
): {
  content: McpTextContent[]
  structuredContent?: { result: { error: ErrorEnvelopeMeta & { message: string } } }
  isError: true
} {
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
  return tags.map(t => {
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>
      if (typeof o.name === 'string') return o.name
      if (typeof o.tag === 'string') return o.tag
      return String(o.id ?? t)
    }
    return String(t)
  })
}

const BOOLEAN_FIELDS = new Set(['is_protected', 'is_global', 'is_cluster'])

function toBoolean(value: unknown): boolean {
  return value === true || value === 1
}

function hygienicValue(field: string, value: unknown): unknown {
  if (field === 'tags') return stringifyTags(value)
  if (BOOLEAN_FIELDS.has(field)) return toBoolean(value)
  return value
}

function hygienicThought(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(t)) out[key] = hygienicValue(key, value)
  return out
}

export function shapeThought(
  thought: unknown,
  compact?: boolean,
  fields?: unknown,
  urlLinks?: BatchUrlLinks
): unknown {
  const shaped = projectThoughtShape(thought, compact, fields)
  if (urlLinks === undefined || !shaped || typeof shaped !== 'object' || Array.isArray(shaped))
    return shaped
  return { ...(shaped as Record<string, unknown>), url_links: urlLinksOf(thought, urlLinks) }
}

function projectThoughtShape(thought: unknown, compact?: boolean, fields?: unknown): unknown {
  if (!thought || typeof thought !== 'object' || Array.isArray(thought)) return thought
  const t = thought as Record<string, unknown>
  const compactFlag = compact === true
  const requested = Array.isArray(fields)
    ? fields.map(v => String(v).trim()).filter(Boolean)
    : typeof fields === 'string'
      ? fields
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
      : []
  const fieldList: string[] =
    requested.length > 0 ? [...requested] : compactFlag ? [...COMPACT_FIELDS] : []
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

export function shapeChain(
  chain: ChainResult | null | undefined,
  compact: boolean,
  fields: unknown,
  urlLinks?: BatchUrlLinks
): ChainResult | null | undefined {
  if (!chain) return chain
  return {
    ...chain,
    thought: chain.thought
      ? (shapeThought(chain.thought, compact, fields, urlLinks) as ChainResult['thought'])
      : chain.thought,
    upstream: Array.isArray(chain.upstream)
      ? chain.upstream.map(e => ({
          ...e,
          thought: e?.thought
            ? (shapeThought(e.thought, compact, fields, urlLinks) as typeof e.thought)
            : e?.thought
        }))
      : chain.upstream,
    downstream: Array.isArray(chain.downstream)
      ? chain.downstream.map(e => ({
          ...e,
          thought: e?.thought
            ? (shapeThought(e.thought, compact, fields, urlLinks) as typeof e.thought)
            : e?.thought
        }))
      : chain.downstream
  }
}

export interface UrlLinkView {
  text: string
  url: string
  label: string
}

export type BatchUrlLinks = Map<string, UrlLinkView[]>

export function loadUrlLinks(thoughts: ReadonlyArray<unknown>): BatchUrlLinks {
  const ids: string[] = []
  for (const thought of thoughts) {
    if (!thought || typeof thought !== 'object') continue
    const id = (thought as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  const byThought: BatchUrlLinks = new Map()
  if (ids.length === 0) return byThought
  for (const [thoughtId, rows] of Object.entries(
    getThoughtUrlLinksBatchService([...new Set(ids)])
  )) {
    byThought.set(
      thoughtId,
      rows.map(row => ({ text: row.key, url: row.url, label: row.label }))
    )
  }
  return byThought
}

function urlLinksOf(thought: unknown, urlLinks: BatchUrlLinks): UrlLinkView[] {
  if (!thought || typeof thought !== 'object') return []
  const id = (thought as { id?: unknown }).id
  return typeof id === 'string' ? (urlLinks.get(id) ?? []) : []
}
