import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { instrumentServer } from '../telemetry'
import { registerMemoryRecall } from './recall'
import { registerMemoryStore } from './store'
import { registerMemorySupersede } from './supersede'
import { registerMemoryStatus } from './status'
import { registerMemoryManage } from './manage'
import { registerMemoryCrystallize } from './crystallize'
import { registerMemoryReflect } from './reflect'
import { registerMemoryTelemetry } from './telemetry'
import { registerMemoryGuide } from './guide'

export function registerAllMemoryTools(server: McpServer): void {
  // Wrap registerTool first so every tool dispatch writes a telemetry row.
  instrumentServer(server)
  registerMemoryRecall(server)
  registerMemoryStore(server)
  registerMemorySupersede(server)
  registerMemoryStatus(server)
  registerMemoryManage(server)
  registerMemoryCrystallize(server)
  registerMemoryReflect(server)
  registerMemoryTelemetry(server)
  registerMemoryGuide(server)
}
