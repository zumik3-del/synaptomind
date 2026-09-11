import { z } from 'zod/v4'
import { resolveProjectService } from '../../services/projects.service'

type McpTextContent = { type: 'text'; text: string }

/**
 * Declared output shape shared by every MCP tool. Tools multiplex several
 * actions with heterogeneous payloads, so the typed envelope keeps a single
 * stable contract: every successful result is `{ result: <payload> }`, where
 * the payload matches the JSON in `content[].text`.
 */
export const toolOutputShape = { result: z.unknown().describe('Action payload, mirroring content[].text') }

export function jsonResult(data: unknown): { content: McpTextContent[]; structuredContent: { result: unknown } } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data }
  }
}

export function errorResult(message: string): { content: McpTextContent[]; isError: true } {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
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
