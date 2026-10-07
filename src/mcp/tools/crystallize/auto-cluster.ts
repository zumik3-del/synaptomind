import { runAutoClusterJob } from '../../../services/auto-cluster.service'
import { type ActionArgs, type ActionHandler } from '../action-tool'

/**
 * Normalize an optional numeric argument that may arrive as a number or as a
 * numeric string (MCP clients differ in how they serialize numbers). Returns
 * `undefined` for absent/blank/non-finite values so the service falls back to
 * `config.autoCluster.*` defaults.
 */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize an optional boolean argument, tolerating `'true'`/`'false'` strings. */
function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

export const autoClusterHandler: ActionHandler = {
  // auto_cluster is a global operation and must not resolve or warn about a project.
  async run(args: ActionArgs) {
    return runAutoClusterJob({
      minAgeDays: optionalNumber(args.min_age_days),
      minSimilarity: optionalNumber(args.min_similarity),
      minMembers: optionalNumber(args.min_members),
      dryRun: optionalBoolean(args.dry_run)
    })
  }
}
