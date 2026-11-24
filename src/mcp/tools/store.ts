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
    description: `Store and modify thoughts. Answers the shared envelope: { item, meta } for a single-object action, { items, meta } for a batch; meta.counts carries the aggregate (linked/failed, created/failed, deleted/failed). A non-mutating preview sets meta.preview={token,destructive:true}. Actions: create, update (tags merge by default; tags_mode=replace to overwrite), link, link_batch (one run-level transaction with a savepoint per item, so a failing item does not roll back its neighbours; per-item results), unlink (preview→confirm; dry-run default), unlink_batch (one transaction, per-edge status, confirm-gated), retype (preview→confirm; returns old/new edge id), bulk_create (create up to ${BULK_ITEMS_MAX} thoughts in one run-level transaction with a savepoint per item, so a failing item does not roll back its neighbours; each item takes memory_store action=create's item shape plus project_id, relation and source). Every action refuses an argument that belongs to another one, and the thoughts a write returns are compact (id, content, status, tags, project) unless you read the row back with memory_recall compact=false.`,
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
