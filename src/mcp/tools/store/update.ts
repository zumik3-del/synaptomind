import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { updateThoughtByIdService } from '../../../services/thoughts.service'
import type { ThoughtStatus } from '../../../types/thought'
import { resolveProjectId } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const updateHandler: ActionHandler = {
  input: z.object({
    thought_id: requiredString('thought_id is required for update action'),
    is_profile: z.never({ error: 'is_profile is retired; remove this field. There is no replacement.' }).optional()
  }),
  run(args: ActionArgs) {
    const updated = updateThoughtByIdService(args.thought_id as string, {
      content: args.content as string | undefined, tags: args.tags as string[] | undefined, tags_mode: args.tags_mode as 'replace' | 'merge' | undefined, status: args.status as ThoughtStatus | undefined, project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_protected: args.is_protected as boolean | undefined, is_global: args.is_global as boolean | undefined
    })
    if (!updated) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
    return updated
  }
}
