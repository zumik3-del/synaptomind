import { runHealthCheckService } from '../../../services/health-check.service'
import type { ActionArgs, ActionHandler } from '../action-tool'

/** Maximum characters retained for any `*content*` field in MCP health details. */
const CONTENT_LIMIT = 80

/** Trim a content string to ~80 chars (no ellipsis, matching the retention-review convention). */
function shortContent(value: string): string {
  return value.length > CONTENT_LIMIT ? value.slice(0, CONTENT_LIMIT) : value
}

/** Recursively shorten string fields whose key contains "content" in a detail object. */
function slimDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slimDetail)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && key.toLowerCase().includes('content')) {
      out[key] = shortContent(val)
    } else if (Array.isArray(val) || (val !== null && typeof val === 'object')) {
      out[key] = slimDetail(val)
    } else {
      out[key] = val
    }
  }
  return out
}

/** MCP-only projection: drop duplicate score keys, slim detail content. Service output untouched. */
export function projectHealthReport(report: any): any {
  const { summary, categories, ...rest } = report ?? {}
  // Keep a single score (health_score) + one score_breakdown; drop duplicate aliases.
  const {
    score_composition,
    score_explanation,
    score_components,
    score_details,
    score_formula,
    formula,
    ...slimSummary
  } = summary ?? {}

  const slimCategories = Array.isArray(categories)
    ? categories.map((cat: any) => ({
        ...cat,
        checks: Array.isArray(cat?.checks)
          ? cat.checks.map((check: any) => ({
              ...check,
              details: Array.isArray(check?.details) ? check.details.map(slimDetail) : check?.details,
            }))
          : cat?.checks,
      }))
    : categories

  return { ...rest, summary: slimSummary, categories: slimCategories }
}

export const healthHandler: ActionHandler = {
  run(args: ActionArgs) {
    const report = runHealthCheckService({ severity: args.severity as 'critical' | 'warning' | 'info' | undefined, fix: args.fix as boolean | undefined })
    return projectHealthReport(report)
  }
}