import { z } from 'zod/v4'
import { rollbackService as rollbackRun } from '../../../services/placement-rollback.service'
import { listAcceptedProposalsByRunService } from '../../../services/placement-proposals.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../../services/preview-tokens.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { AGENT } from './apply'

function rollbackFingerprint(runId: string, rows: { id: string; state: string }[]): string {
  return `${runId}:${rows.length}:${rows.map(r => `${r.id}:${r.state}`).join(',')}`
}

export const rollbackHandler: ActionHandler = {
  input: z.object({ run_id: requiredString('run_id is required for rollback action'), preview_token: z.string().optional() }),
  run(args: ActionArgs) {
    const runId = args.run_id as string
    const confirm = args.confirm === true
    const previewToken = args.preview_token as string | undefined
    const rows = listAcceptedProposalsByRunService(runId)

    if (!confirm) {
      const result = rollbackRun(runId, { confirm: false, decidedBy: AGENT })
      const token = createPreviewTokenService('rollback', runId, rollbackFingerprint(runId, rows))
      return { ...(result as unknown as Record<string, unknown>), preview_token: token }
    }

    const fp = rollbackFingerprint(runId, rows)
    if (!previewToken) throw new Error('preview_token is required')
    const verification = consumePreviewTokenService(previewToken, 'rollback', runId, fp)
    if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)

    return rollbackRun(runId, { confirm: true, decidedBy: AGENT })
  }
}