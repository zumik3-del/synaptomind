import { z } from 'zod/v4'
import { runAutoClusterJob } from '../../../services/auto-cluster.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../../services/preview-tokens.service'
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

function autoClusterFingerprint(result: { candidates: number; groups: { members: string[] }[] }): string {
  return `${result.candidates}:${result.groups.length}:${result.groups.map(g => g.members.join(',')).join('|')}`
}

export const autoClusterHandler: ActionHandler = {
  input: z.object({ preview_token: z.string().optional() }),
  // auto_cluster is a global operation and must not resolve or warn about a project.
  async run(args: ActionArgs) {
    const confirm = args.confirm === true
    const previewToken = args.preview_token as string | undefined
    const opts = {
      minAgeDays: optionalNumber(args.min_age_days),
      minSimilarity: optionalNumber(args.min_similarity),
      minMembers: optionalNumber(args.min_members)
    }
    if (!confirm) {
      const result = await runAutoClusterJob({ ...opts, dryRun: true })
      const token = createPreviewTokenService('auto_cluster', 'global', autoClusterFingerprint(result))
      return {
        status: 'preview',
        candidates: result.candidates,
        groups: result.groups,
        consequence: result.groups.length > 0
          ? `Creates ${result.groups.length} cluster(s) from ${result.candidates} candidate thought(s).`
          : 'No clusters meet the criteria — confirming creates nothing.',
        instruction: 'Call memory_crystallize again with action=auto_cluster, confirm=true to proceed.',
        preview_token: token
      }
    }
    const dry = await runAutoClusterJob({ ...opts, dryRun: true })
    const fp = autoClusterFingerprint(dry)
    if (!previewToken) throw new Error('preview_token is required')
    const verification = consumePreviewTokenService(previewToken, 'auto_cluster', 'global', fp)
    if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
    const result = await runAutoClusterJob({ ...opts, dryRun: false })
    return {
      status: 'executed',
      candidates: result.candidates,
      groups: result.groups,
      clusters_created: result.clusters_created
    }
  }
}