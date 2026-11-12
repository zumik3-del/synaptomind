import { z } from 'zod/v4'
import { runAutoCluster } from '../../../services/auto-cluster.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { collectionEnvelope } from '../envelope'
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
  input: z.object({ preview_token: z.string().optional() }),
  // auto_cluster is a global operation and must not resolve or warn about a project.
  async run(args: ActionArgs) {
    const opts = {
      minAgeDays: optionalNumber(args.min_age_days),
      minSimilarity: optionalNumber(args.min_similarity),
      minMembers: optionalNumber(args.min_members)
    }
    const planned = await runAutoCluster({ ...opts, dryRun: true })
    const outcome = await runGuarded(args, {
      kind: 'auto_cluster',
      targetId: 'global',
      fingerprint: () =>
        fingerprintOf(
          planned.candidates,
          planned.groups.length,
          planned.groups.map(group => group.members)
        ),
      preview: token =>
        collectionEnvelope('auto_cluster', planned.groups, {
          total: planned.candidates,
          counts: { candidates: planned.candidates, clusters: planned.groups.length },
          preview: {
            token,
            consequence:
              planned.groups.length > 0
                ? `Creates ${planned.groups.length} cluster(s) from ${planned.candidates} candidate thought(s).`
                : 'No clusters meet the criteria — confirming creates nothing.',
            instruction:
              'Call memory_crystallize again with action=auto_cluster, confirm=true to proceed.'
          }
        }),
      apply: () => runAutoCluster({ ...opts, dryRun: false })
    })

    if (outcome.status === 'preview') return outcome.value
    const result = outcome.value
    return collectionEnvelope('auto_cluster', result.groups, {
      total: result.candidates,
      counts: { candidates: result.candidates, clusters: result.clusters_created }
    })
  }
}
