import { z } from 'zod/v4'
import { rollbackService as rollbackRun } from '../../../services/placement-rollback.service'
import { listAcceptedProposalsByRunService } from '../../../services/placement-proposals.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../../services/preview-tokens.service'
import { collectionEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { AGENT } from './apply'

function rollbackFingerprint(runId: string, rows: { id: string; state: string }[]): string {
  return `${runId}:${rows.length}:${rows.map(r => `${r.id}:${r.state}`).join(',')}`
}

/**
 * `edge_review action=rollback`: the per-row report is the answer (task #2181).
 *
 * Every row of the run becomes one `items` entry and the report's summary
 * becomes `meta.counts` (`reverted`/`skipped`/`refused`). `run_id` is not echoed:
 * the caller supplies it, so it is already known.
 */
export const rollbackHandler: ActionHandler = {
  input: z.object({ run_id: requiredString('run_id is required for rollback action'), preview_token: z.string().optional() }),
  run(args: ActionArgs) {
    const runId = args.run_id as string
    const confirm = args.confirm === true
    const previewToken = args.preview_token as string | undefined
    const rows = listAcceptedProposalsByRunService(runId)

    if (!confirm) {
      const report = rollbackRun(runId, { confirm: false, decidedBy: AGENT })
      const token = createPreviewTokenService('rollback', runId, rollbackFingerprint(runId, rows))
      return collectionEnvelope('rollback', report.items, {
        total: report.items.length,
        counts: report.summary,
        preview: { token }
      })
    }

    const fp = rollbackFingerprint(runId, rows)
    if (!previewToken) throw new Error('preview_token is required')
    const verification = consumePreviewTokenService(previewToken, 'rollback', runId, fp)
    if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)

    const report = rollbackRun(runId, { confirm: true, decidedBy: AGENT })
    return collectionEnvelope('rollback', report.items, { total: report.items.length, counts: report.summary })
  }
}
