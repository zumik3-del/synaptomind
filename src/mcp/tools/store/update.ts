import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { updateThoughtByIdService } from '../../../services/thoughts.service'
import type { ThoughtStatus } from '../../../types/thought'
import { itemEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeThought } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/**
 * `update` is not an archive path (task #2207): archiving is destructive, so it
 * goes through `memory_supersede action=archive` and its preview token, never a
 * plain write that skips the preview. The advertised `status` enum still offers
 * `archived` (the `create` action needs it), so the action-conditional schema
 * narrows it here and rejects the value with the replacement path.
 */
const ARCHIVED_NEEDS_SUPERSEDE =
  'update cannot set status "archived"; use memory_supersede action=archive (preview, then confirm:true with its preview_token)'

export const updateHandler: ActionHandler = {
  input: z.object({
    thought_id: requiredString('thought_id is required for update action'),
    status: z
      .enum(['draft', 'active'], { error: ARCHIVED_NEEDS_SUPERSEDE })
      .optional()
      .describe('draft or active only; archiving goes through memory_supersede action=archive.'),
    is_profile: z.never({ error: 'is_profile is retired; remove this field. There is no replacement.' }).optional(),
    surface_after: z.iso.datetime().nullable().optional()
  }),
  run(args: ActionArgs) {
    const updated = updateThoughtByIdService(args.thought_id as string, {
      content: args.content as string | undefined, tags: args.tags as string[] | undefined, tags_mode: args.tags_mode as 'replace' | 'merge' | undefined, status: args.status as ThoughtStatus | undefined, project_id: resolveProjectId(args.cwd as string), is_protected: args.is_protected as boolean | undefined, is_global: args.is_global as boolean | undefined, surface_after: args.surface_after === undefined ? undefined : (args.surface_after as string | null)
    })
    if (!updated) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
    return itemEnvelope('update', shapeThought(updated), writeEnvelopeScope(args.cwd))
  }
}
