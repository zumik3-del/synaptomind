import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { formatZodIssues } from '../../zod-utils'
import { errorResult, jsonResult, toolOutputShape } from './utils'

export type ActionArgs = Record<string, unknown>

export interface ActionHandler {
  input?: z.ZodType
  run(args: ActionArgs): unknown | Promise<unknown>
}

export interface ActionToolConfig {
  name: string
  description: string
  // The MCP SDK cannot advertise a discriminated-union schema (it serializes to an empty object), so the per-action union lives in `ActionHandler.input`.
  inputSchema: Record<string, z.ZodType>
  handlers: Record<string, ActionHandler>
}

function isToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  )
}

function errorStatusCode(err: unknown): number | undefined {
  if (err instanceof Error && 'statusCode' in err) {
    const status = (err as { statusCode: unknown }).statusCode
    if (typeof status === 'number') return status
  }
  return undefined
}

export function requiredString(message: string): z.ZodString {
  return z.string({ error: message }).min(1, message)
}

export function registerActionTool(server: McpServer, config: ActionToolConfig): void {
  server.registerTool(
    config.name,
    {
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: toolOutputShape
    },
    async args => {
      const action = String(args.action)
      try {
        const handler = config.handlers[action]
        if (!handler) return errorResult(`Unknown action: ${action}`)

        let effectiveArgs: ActionArgs = args
        if (handler.input) {
          const parsed = handler.input.safeParse(args)
          if (!parsed.success) return errorResult(formatZodIssues(parsed.error))
          effectiveArgs = { ...args, ...(parsed.data as ActionArgs) }
        }

        const result = await handler.run(effectiveArgs)
        return isToolResult(result) ? result : jsonResult(result)
      } catch (err) {
        const statusCode = errorStatusCode(err)
        return errorResult(
          err instanceof Error ? err.message : `${config.name} failed`,
          statusCode === undefined ? {} : { statusCode, retryable: statusCode === 503 }
        )
      }
    }
  )
}
