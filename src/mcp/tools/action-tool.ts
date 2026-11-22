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
  // Every action carries its own schema, so an argument outside it is refused instead of ignored.
  input: z.ZodObject<z.ZodRawShape>
  run(args: ActionArgs): unknown | Promise<unknown>
}

export interface ActionToolConfig {
  name: string
  description: string
  // The MCP SDK cannot advertise a discriminated-union schema (it serializes to an empty object), so the advertised
  // shape stays flat and each action's `input` narrows it.
  inputSchema: Record<string, z.ZodType>
  handlers: Record<string, ActionHandler>
}

// `cwd` is the universal envelope argument: every action accepts it, and only the schema of an action that reads it
// validates it. `action` carries no meaning inside an action's own arguments.
const UNIVERSAL_ARGS = new Set(['action', 'cwd'])

export function actionInput(
  args: Record<string, z.ZodType>,
  fields: readonly string[],
  overrides: Record<string, z.ZodType> = {}
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {}
  for (const field of fields) {
    const schema = overrides[field] ?? args[field]
    if (schema === undefined) throw new Error(`"${field}" is not an advertised argument`)
    shape[field] = schema
  }
  return z.object(shape)
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

function irrelevantArgs(action: string, args: ActionArgs, accepted: Set<string>): string[] {
  return Object.keys(args).filter(key => !UNIVERSAL_ARGS.has(key) && !accepted.has(key))
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

        const accepted = new Set(Object.keys(handler.input.shape))
        const irrelevant = irrelevantArgs(action, parsed, accepted)
        if (irrelevant.length)
          return errorResult(`${irrelevant.join(', ')} is not applicable to ${action} action`)

        const candidate: ActionArgs = { ...parsed }
        delete candidate.action
        if (!accepted.has('cwd')) delete candidate.cwd
        const argsResult = handler.input.safeParse(candidate)
        if (!argsResult.success) return errorResult(formatZodIssues(argsResult.error))
        const effectiveArgs: ActionArgs = { ...parsed, ...(argsResult.data as ActionArgs) }

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
