import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { errorResult, jsonResult, toolOutputShape } from './utils'

/** Arguments passed to an action handler after the advertised schema has parsed them. */
export type ActionArgs = Record<string, unknown>

/**
 * One action of a multiplexed MCP tool.
 *
 * `input` is the action-conditional request schema: it only has to declare the
 * fields this action requires (the handler still receives the full argument
 * object). When present it replaces the old inline `if (!args.x) throw`
 * checks, so missing/invalid fields surface as a normal `isError` envelope with
 * a precise message (audit F18).
 */
export interface ActionHandler {
  input?: z.ZodType
  run(args: ActionArgs): unknown | Promise<unknown>
}

export interface ActionToolConfig {
  name: string
  description: string
  /**
   * Advertised argument shape shared by every action: a superset where only
   * `action` is required. The MCP SDK cannot advertise a discriminated-union
   * schema (it would serialize to an empty object), so the union lives in
   * per-action `input` schemas while the superset stays discoverable.
   */
  inputSchema: z.ZodRawShape
  handlers: Record<string, ActionHandler>
}

function isToolResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content)
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => issue.message).join('; ')
}

/** Required non-empty string with one message reused for both missing and empty input. */
export function requiredString(message: string): z.ZodString {
  return z.string({ error: message }).min(1, message)
}

/**
 * Register a single MCP tool that multiplexes several actions behind `action`.
 *
 * Every action tool shares one dispatch path: look up the handler, enforce its
 * action-conditional schema, then run inside a single try/catch that converts
 * any failure into the `isError` envelope. This replaces the previous mix of
 * `actionHandlers` maps and inline if-chains (audit F8) and guarantees
 * project-resolution errors are caught like any other action failure (F9).
 *
 * A handler may return a ready-made tool result (for non-JSON payloads such as
 * `memory_status` action=config); anything else is wrapped in `jsonResult`.
 */
export function registerActionTool(server: McpServer, config: ActionToolConfig): void {
  server.registerTool(
    config.name,
    {
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: toolOutputShape
    },
    async (args) => {
      const action = String(args.action)
      try {
        const handler = config.handlers[action]
        if (!handler) return errorResult(`Unknown action: ${action}`)

        if (handler.input) {
          const parsed = handler.input.safeParse(args)
          if (!parsed.success) return errorResult(formatIssues(parsed.error))
        }

        const result = await handler.run(args)
        return isToolResult(result) ? result : jsonResult(result)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : `${config.name} failed`)
      }
    }
  )
}
