import { z } from 'zod/v4'
import { updateThoughtById } from '../../../services/thoughts.service'
import type { ThoughtStatus } from '../../../types/thought'
import { resolveProjectId } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const updateHandler: ActionHandler = {
  input: z.object({ thought_id: requiredString('thought_id is required for update action') }),
  run(args: ActionArgs) {
    const updated = updateThoughtById(args.thought_id as string, {
      content: args.content as string | undefined, tags: args.tags as string[] | undefined, status: args.status as ThoughtStatus | undefined, project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_profile: args.is_profile as boolean | undefined, is_protected: args.is_protected as boolean | undefined, is_global: args.is_global as boolean | undefined
    })
    if (!updated) throw new Error(`Thought '${args.thought_id}' not found`)
    return updated
  }
}
