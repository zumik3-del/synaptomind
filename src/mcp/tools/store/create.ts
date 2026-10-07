import { z } from 'zod/v4'
import { createThoughtWithUrlLinks } from '../../../services/thoughts.service'
import type { ThoughtStatus } from '../../../types/thought'
import { resolveProjectId } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const createHandler: ActionHandler = {
  input: z.object({ content: requiredString('content is required for create action') }),
  run(args: ActionArgs) {
    return createThoughtWithUrlLinks(
      { content: args.content as string, tags: args.tags as string[] | undefined, status: args.status as ThoughtStatus | undefined, source: 'mcp', project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_profile: args.is_profile as boolean | undefined, is_protected: args.is_protected as boolean | undefined },
      { parentId: args.parent_id as string | undefined, urlLinks: args.url_links as { text: string; url: string }[] | undefined }
    )
  }
}
