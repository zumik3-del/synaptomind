import { runAutoCluster } from '../../../services/auto-cluster.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { collectionEnvelope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { CRYSTALLIZE_ARGS } from './args'

export const autoClusterHandler: ActionHandler = {
  input: actionInput(CRYSTALLIZE_ARGS, [
    'min_age_days',
    'min_similarity',
    'min_members',
    'confirm',
    'preview_token'
  ]),
  async run(args: ActionArgs) {
    const opts = {
      minAgeDays: args.min_age_days as number | undefined,
      minSimilarity: args.min_similarity as number | undefined,
      minMembers: args.min_members as number | undefined
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
