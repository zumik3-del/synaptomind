import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerMemoryRecall } from './recall'
import { registerMemoryStore } from './store'
import { registerMemorySupersede } from './supersede'
import { registerMemoryStatus } from './status'
import { registerMemoryManage } from './manage'
import { registerMemoryCrystallize } from './crystallize'
import { registerMemoryReflect } from './reflect'
import { registerMemoryTelemetry } from './telemetry'
import { registerMemoryGit } from './git'
import { registerMemoryGuide } from './guide'

export function registerAllMemoryTools(server: McpServer): void {
  registerMemoryRecall(server)
  registerMemoryStore(server)
  registerMemorySupersede(server)
  registerMemoryStatus(server)
  registerMemoryManage(server)
  registerMemoryCrystallize(server)
  registerMemoryReflect(server)
  registerMemoryTelemetry(server)
  registerMemoryGit(server)
  registerMemoryGuide(server)
}
