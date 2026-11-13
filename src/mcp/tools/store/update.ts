import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { updateThoughtByIdService } from '../../../services/thoughts.service'
import type { ThoughtStatus } from '../../../types/thought'
import { itemEnvelope, writeEnvelopeScope } from '../envelope'
import { shapeThought } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

const ARCHIVED_NEEDS_SUPERSEDE =
  'update cannot set status "archived"; use memory_supersede action=archive (preview, then confirm:true with its preview_token)'

export const updateHandler: ActionHandler = {
  input: z.object({
    thought_id: requiredString('thought_id is required for update action'),
    status: z
      .enum(['draft', 'active'], {
        error: issue => (issue.input === 'archived' ? ARCHIVED_NEEDS_SUPERSEDE : undefined)
      })
      .optional()
      .describe('draft or active only; archiving goes through memory_supersede action=archive.'),
    is_profile: z
      .never({ error: 'is_profile is retired; remove this field. There is no replacement.' })
      .optional(),
    surface_after: z.iso.datetime().nullable().optional()
  }),
  run(args: ActionArgs) {
    // Id-addressed write: cwd scopes the answer, it never relocates the row (docs/mcp-tools.md).
    const updated = updateThoughtByIdService(args.thought_id as string, {
      content: args.content as string | undefined,
      tags: args.tags as string[] | undefined,
      tags_mode: args.tags_mode as 'replace' | 'merge' | undefined,
      status: args.status as ThoughtStatus | undefined,
      is_protected: args.is_protected as boolean | undefined,
      is_global: args.is_global as boolean | undefined,
      surface_after:
        args.surface_after === undefined ? undefined : (args.surface_after as string | null)
    })
    if (!updated) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
    return itemEnvelope('update', shapeThought(updated), writeEnvelopeScope(args.cwd))
  }
}
