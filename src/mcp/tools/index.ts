import type { McpServer } from '@modelcontextprotocol/server'
import { config, type Config } from '../../config'
import { registerMemoryRecall } from './recall'
import { registerMemoryStore } from './store'
import { registerMemorySupersede } from './supersede'
import { registerMemoryStatus } from './status'
import { registerMemoryProjects } from './manage'
import { registerMemoryCrystallize } from './crystallize'
import { registerMemoryReflect } from './reflect'
import { registerMemoryPrimers } from './primers'
import { registerMemoryGuide } from './guide'
import { registerMemoryRetention } from './retention-review'

export function registerAllMemoryTools(server: McpServer, cfg: Config = config): void {
  registerMemoryRecall(server)
  registerMemoryStore(server, cfg)
  registerMemorySupersede(server)
  registerMemoryStatus(server)
  registerMemoryProjects(server)
  registerMemoryCrystallize(server)
  registerMemoryReflect(server)
  registerMemoryPrimers(server)
  registerMemoryRetention(server)
  registerMemoryGuide(server, cfg)
}
