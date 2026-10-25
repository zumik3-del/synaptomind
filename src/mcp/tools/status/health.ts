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

/** MCP-only projection: drop duplicate score keys, slim detail content. Service output untouched.
 *
 * Details arrays are opt-in: by default they are omitted (summary + counts stay),
 * and only included (slimmed) when `includeDetails` is true.
 */
function projectHealthReport(report: unknown, includeDetails: boolean = false): unknown {
  const r = (report ?? {}) as Record<string, unknown>
  const { summary, categories, ...rest } = r
  const s = (summary ?? {}) as Record<string, unknown>
  // Keep a single score (health_score) + one score_breakdown; drop duplicate aliases.
  const {
    score_composition: _score_composition,
    score_explanation: _score_explanation,
    score_components: _score_components,
    score_details: _score_details,
    score_formula: _score_formula,
    formula: _formula,
    ...slimSummary
  } = s

  const slimCategories = Array.isArray(categories)
    ? categories.map((cat: unknown) => {
        const c = (cat ?? {}) as Record<string, unknown>
        const checks = Array.isArray(c.checks) ? c.checks : undefined
        return {
          ...c,
          checks: Array.isArray(checks)
            ? checks.map((check: unknown) => {
                const ch = (check ?? {}) as Record<string, unknown>
                if (!includeDetails) {
                  const { details: _details, ...restCheck } = ch
                  return restCheck
                }
                const { details, ...restCheck } = ch
                return {
                  ...restCheck,
                  details: Array.isArray(details) ? details.map(slimDetail) : details,
                }
              })
            : checks,
        }
      })
    : categories

  return { ...rest, summary: slimSummary, categories: slimCategories }
}

export const healthHandler: ActionHandler = {
  run(args: ActionArgs) {
    const report = runHealthCheckService({ severity: args.severity as 'critical' | 'warning' | 'info' | undefined, fix: args.fix as boolean | undefined })
    return projectHealthReport(report, args.include_details === true)
  }
}