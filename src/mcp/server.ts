import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerThoughtTools } from './tools/thoughts'
import { registerGraphTools } from './tools/graph'
import { registerProjectTools } from './tools/projects'
import { registerSmartNoteTools } from './tools/smart-notes'
import { registerSlotTools } from './tools/slots'
import { registerFrontierTools } from './tools/frontier'
import { registerProfileTools } from './tools/profile'
import { registerPrimerTools } from './tools/primers'
import { registerTelemetryTools } from './tools/telemetry'
import { registerCrystalTools } from './tools/crystals'
import { registerGitCommitTools } from './tools/git-commits'
import { registerGuideTools } from './tools/guide'
import { registerConfigTools } from './tools/config'
import { registerHealthCheckTools } from './tools/health-check'

const pkg = JSON.parse(await Bun.file(`${import.meta.dir}/../../package.json`).text()) as { version: string }

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'synaptomind',
    version: pkg.version
  })

  registerThoughtTools(server)
  registerGraphTools(server)
  registerProjectTools(server)
  registerSmartNoteTools(server)
  registerSlotTools(server)
  registerFrontierTools(server)
  registerProfileTools(server)
  registerPrimerTools(server)
  registerTelemetryTools(server)
  registerCrystalTools(server)
  registerGitCommitTools(server)
  registerGuideTools(server)
  registerConfigTools(server)
  registerHealthCheckTools(server)

  return server
}
