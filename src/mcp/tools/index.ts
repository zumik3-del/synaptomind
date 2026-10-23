import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerMemoryRecall } from './recall'
import { registerMemoryStore } from './store'
import { registerMemorySupersede } from './supersede'
import { registerMemoryStatus } from './status'
import { registerMemoryManage } from './manage'
import { registerMemoryCrystallize } from './crystallize'
import { registerMemoryReflect } from './reflect'
import { registerMemoryPrimers } from './primers'
import { registerEdgeReview } from './review'
import { registerMemoryGuide } from './guide'

export function registerAllMemoryTools(server: McpServer): void {
  registerMemoryRecall(server)
  registerMemoryStore(server)
  registerMemorySupersede(server)
  registerMemoryStatus(server)
  registerMemoryManage(server)
  registerMemoryCrystallize(server)
  registerMemoryReflect(server)
  registerMemoryPrimers(server)
  registerEdgeReview(server)
  registerMemoryGuide(server)
}
