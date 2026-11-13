import type { z } from 'zod/v4'

export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map(issue => issue.message).join('; ')
}
