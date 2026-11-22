import type {
  McpServer,
  CallToolResult,
  StandardSchemaWithJSON
} from '@modelcontextprotocol/server'
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

// The SDK validates arguments before the handler runs and answers a text-only error, so the
// advertised schema keeps its JSON Schema while `validate` is neutralized and the handler refuses.
function advertisedArgsSchema(
  shape: Record<string, z.ZodType>
): StandardSchemaWithJSON<ActionArgs, ActionArgs> {
  const standard = z.object(shape)['~standard'] as StandardSchemaWithJSON<
    ActionArgs,
    ActionArgs
  >['~standard']
  return { '~standard': { ...standard, validate: value => ({ value: value as ActionArgs }) } }
}

// Argument refusals keep the SDK's wording so a rejected call reads the same as before.
function formatArgsIssues(toolName: string, error: z.ZodError): string {
  const issues = error.issues
    .map(issue => {
      if (issue.path.length === 0) return issue.message
      const path = issue.path.map(segment => String(segment)).join('.')
      return `${path}: ${issue.message}`
    })
    .join(', ')
  return `Input validation error: Invalid arguments for tool ${toolName}: ${issues}`
}

export function requiredString(message: string): z.ZodString {
  return z.string({ error: message }).min(1, message)
}

export function registerActionTool(server: McpServer, config: ActionToolConfig): void {
  const argsSchema = z.object(config.inputSchema)
  server.registerTool(
    config.name,
    {
      description: config.description,
      inputSchema: advertisedArgsSchema(config.inputSchema),
      // The SDK's typed overload pairs a schema `inputSchema` with a schema `outputSchema`.
      outputSchema: z.object(toolOutputShape)
    },
    async args => {
      const parsedArgs = argsSchema.safeParse(args)
      if (!parsedArgs.success) return errorResult(formatArgsIssues(config.name, parsedArgs.error))
      const parsed = parsedArgs.data as ActionArgs
      const action = String(parsed.action)
      try {
        const handler = config.handlers[action]
        if (!handler) return errorResult(`Unknown action: ${action}`)

        let effectiveArgs: ActionArgs = parsed
        if (handler.input) {
          const argsResult = handler.input.safeParse(parsed)
          if (!argsResult.success) return errorResult(formatZodIssues(argsResult.error))
          effectiveArgs = { ...parsed, ...(argsResult.data as ActionArgs) }
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
