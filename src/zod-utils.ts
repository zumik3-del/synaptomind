import type { z } from 'zod/v4'

/** Join validation issue messages for HTTP and MCP error responses. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map(issue => issue.message).join('; ')
}
