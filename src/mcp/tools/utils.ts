import { z } from 'zod/v4'
import type { ChainResult } from '../../services/graph.service'
import { resolveProjectService } from '../../services/projects.service'
import { getThoughtUrlLinksBatchService } from '../../services/url_links.service'

import { shapeEntity, type BatchUrlLinks, type ShapeOptions } from './field-selection'
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
  structuredContent: { result: { error: ErrorEnvelopeMeta & { message: string } } }
  isError: true
} {
  const content: McpTextContent[] = [{ type: 'text' as const, text: message }]
  const error: ErrorEnvelopeMeta & { message: string } = { message }
  if (meta.statusCode !== undefined) error.statusCode = meta.statusCode
  if (meta.retryable !== undefined) error.retryable = meta.retryable
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

export function shapeChain(
  chain: ChainResult | null | undefined,
  options: ShapeOptions = {}
): ChainResult | null | undefined {
  if (!chain) return chain
  return {
    ...chain,
    thought: chain.thought
      ? (shapeEntity(chain.thought, options) as ChainResult['thought'])
      : chain.thought,
    upstream: Array.isArray(chain.upstream)
      ? chain.upstream.map(e => ({
          ...e,
          thought: e?.thought ? (shapeEntity(e.thought, options) as typeof e.thought) : e?.thought
        }))
      : chain.upstream,
    downstream: Array.isArray(chain.downstream)
      ? chain.downstream.map(e => ({
          ...e,
          thought: e?.thought ? (shapeEntity(e.thought, options) as typeof e.thought) : e?.thought
        }))
      : chain.downstream
  }
}

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
