import { z } from 'zod/v4'
import { createThoughtWithUrlLinksService } from '../../../services/url_links.service'
import type { ThoughtStatus } from '../../../types/thought'
import { thoughtStatusSchema } from '../../../validation'
import { itemEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeThought } from '../utils'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const urlLinkItem = z.object({ text: z.string(), url: z.string() })

export const isProfileRefusal = z
  .never({ error: 'is_profile is retired; remove this field. There is no replacement.' })
  .optional()

export function createItemShape(contentMessage: string) {
  return {
    content: requiredString(contentMessage),
    tags: z.array(z.string()).optional(),
    status: thoughtStatusSchema.optional(),
    parent_id: z.string().optional(),
    is_protected: z.boolean().optional(),
    is_global: z.boolean().optional(),
    url_links: z.array(urlLinkItem).optional()
  }
}

export const createHandler: ActionHandler = {
  input: z.object({
    ...createItemShape('content is required for create action'),
    is_profile: isProfileRefusal
  }),
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
    return itemEnvelope('create', shapeThought(thought), writeEnvelopeScope(args.cwd))
  }
}
