import { runAutoClusterJob } from '../../../services/auto-cluster.service'
import type { ActionArgs, ActionHandler } from '../action-tool'

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

export const autoClusterHandler: ActionHandler = {
  // auto_cluster is a global operation and must not resolve or warn about a project.
  async run(args: ActionArgs) {
    // Confirm semantics: without confirm the run is a non-mutating preview
    // (service dryRun mode); clusters are created only with confirm: true.
    const confirm = args.confirm === true
    const result = await runAutoClusterJob({
      minAgeDays: optionalNumber(args.min_age_days),
      minSimilarity: optionalNumber(args.min_similarity),
      minMembers: optionalNumber(args.min_members),
      dryRun: !confirm
    })
    if (!confirm) {
      return {
        status: 'preview',
        candidates: result.candidates,
        groups: result.groups,
        consequence: result.groups.length > 0
          ? `Creates ${result.groups.length} cluster(s) from ${result.candidates} candidate thought(s).`
          : 'No clusters meet the criteria — confirming creates nothing.',
        instruction: 'Call memory_crystallize again with action=auto_cluster, confirm=true to proceed.'
      }
    }
    return {
      status: 'executed',
      candidates: result.candidates,
      groups: result.groups,
      clusters_created: result.clusters_created
    }
  }
}
