import { createThoughtWithUrlLinksService } from '../../../services/url_links.service'
import type { ThoughtStatus } from '../../../types/thought'
import { itemEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeEntity } from '../utils'
import { actionInput, requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { STORE_ARGS } from './args'

export const createHandler: ActionHandler = {
  input: actionInput(
    STORE_ARGS,
    ['content', 'tags', 'status', 'parent_id', 'is_protected', 'is_global', 'url_links'],
    { content: requiredString('content is required for create action') }
  ),
  run(args: ActionArgs) {
    const thought = createThoughtWithUrlLinksService(
      {
        content: args.content as string,
        tags: args.tags as string[] | undefined,
        status: args.status as ThoughtStatus | undefined,
        source: 'mcp',
        project_id: resolveProjectId(args.cwd as string),
        is_protected: args.is_protected as boolean | undefined,
        is_global: args.is_global as boolean | undefined
      },
      {
        parentId: args.parent_id as string | undefined,
        urlLinks: args.url_links as { text: string; url: string }[] | undefined
      }
    )
    return itemEnvelope('create', shapeEntity(thought), writeEnvelopeScope(args.cwd))
  }
}
