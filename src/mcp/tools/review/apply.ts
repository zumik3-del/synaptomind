import { z } from 'zod/v4'
import { applyProposalService } from '../../../services/placement-apply.service'
import { getProposalService } from '../../../services/placement-proposals.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../../services/preview-tokens.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/** Audit label recorded on apply/reject/rollback decisions (ADR §2.8). */
export const AGENT = 'edge_review'

function proposalFingerprint(row: { id: string; state: string; fingerprint: string; created_at: string; expires_at: string | null; result: string | null; run_id: string | null }): string {
  return `${row.id}:${row.state}:${row.fingerprint}:${row.created_at}:${row.expires_at ?? ''}:${row.result ?? ''}:${row.run_id ?? ''}`
}

export const applyHandler: ActionHandler = {
  input: z.object({ proposal_id: requiredString('proposal_id is required for apply action'), preview_token: z.string().optional() }),
  run(args: ActionArgs) {
    const proposalId = args.proposal_id as string
    const confirm = args.confirm === true
    const previewToken = args.preview_token as string | undefined
    const row = getProposalService(proposalId)

    if (!confirm) {
      const result = applyProposalService(proposalId, {
        confirm: false,
        runId: args.run_id as string | undefined,
        decidedBy: AGENT
      })
      if (row) {
        const token = createPreviewTokenService('apply', proposalId, proposalFingerprint(row))
        ;(result as unknown as Record<string, unknown>).preview_token = token
      }
      return result
    }

    if (!row) throw new Error(`placement proposal '${proposalId}' not found`)
    const fp = proposalFingerprint(row)
    if (!previewToken) throw new Error('preview_token is required')
    const verification = consumePreviewTokenService(previewToken, 'apply', proposalId, fp)
    if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)

    return applyProposalService(proposalId, {
      confirm: true,
      runId: args.run_id as string | undefined,
      decidedBy: AGENT
    })
  }
}