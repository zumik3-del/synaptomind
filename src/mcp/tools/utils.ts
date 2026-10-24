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
