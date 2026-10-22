import { z } from 'zod/v4'
import { createThoughtWithUrlLinksService } from '../../../services/url_links.service'
import type { ThoughtStatus } from '../../../types/thought'
import { resolveProjectId } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const createHandler: ActionHandler = {
  input: z.object({
    content: requiredString('content is required for create action'),
    is_profile: z.never({ error: 'is_profile is retired' }).optional()
  }),
  run(args: ActionArgs) {
    return createThoughtWithUrlLinksService(
      { content: args.content as string, tags: args.tags as string[] | undefined, status: args.status as ThoughtStatus | undefined, source: 'mcp', project_id: resolveProjectId(args.project_id as string, args.cwd as string), is_protected: args.is_protected as boolean | undefined, is_global: args.is_global as boolean | undefined },
      { parentId: args.parent_id as string | undefined, urlLinks: args.url_links as { text: string; url: string }[] | undefined }
    )
  }
}
