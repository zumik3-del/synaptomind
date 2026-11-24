import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { type Config, config } from '../../config'
import { DESTRUCTIVE, registerActionTool } from './action-tool'
import { createHandler } from './store/create'
import { updateHandler } from './store/update'
import { linkHandler } from './store/link'
import { linkBatchHandler } from './store/link-batch'
import { unlinkHandler } from './store/unlink'
import { unlinkBatchHandler } from './store/unlink-batch'
import { retypeHandler } from './store/retype'
import { bulkCreateHandler } from './store/bulk'
import { STORE_ARGS, storeContentArg } from './store/args'
import { BULK_ITEMS_MAX } from '../../services/bulk.service'

const handlers = {
  create: createHandler,
  update: updateHandler,
  link: linkHandler,
  link_batch: linkBatchHandler,
  unlink: unlinkHandler,
  unlink_batch: unlinkBatchHandler,
  retype: retypeHandler,
  bulk_create: bulkCreateHandler
}

export function registerMemoryStore(server: McpServer, cfg: Config = config) {
  registerActionTool(server, {
    name: 'memory_store',
    annotations: DESTRUCTIVE,
    description: `Store and modify thoughts. Answers the shared envelope — { item, meta } for a single object, { items, meta } for a batch, with the aggregate counters in meta.counts — and a non-mutating preview sets meta.preview={token,destructive:true}. Actions: create; update (tags merge by default, tags_mode=replace overwrites); link; link_batch and unlink_batch (up to 1000 edges each, one transaction, one row per occurrence, unlink_batch confirm-gated); unlink and retype (preview→confirm, unlink dry-run by default, retype returns the old and new edge ids); bulk_create (up to ${BULK_ITEMS_MAX} thoughts, each item taking action=create's item shape plus project_id, relation and source). Both batch writes give every item its own savepoint, so a failing item commits its neighbours and reports its own error. Every action refuses an argument that belongs to another one, and a write returns compact thoughts (id, content, status, tags, project) unless you read the row back with memory_recall compact=false.`,
    inputSchema: {
      action: z
        .enum([
          'create',
          'update',
          'link',
          'link_batch',
          'unlink',
          'unlink_batch',
          'retype',
          'bulk_create'
        ])
        .describe(
          'The specific action to perform. This dictates which other parameters are required.'
        ),
      ...STORE_ARGS,
      content: storeContentArg(cfg)
    },
    handlers
  })
}
