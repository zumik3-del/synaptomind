import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'fs'
import { config } from '../config'
import { VERSION } from '../version'
import { registerAllMemoryTools } from './tools'

const defaultInstructions = [
  'SynaptoMind is the persistent memory for this project.',
  '',
  'At the start of a session, load project context with memory_status (action=slots) to understand',
  'the current goals, pending work, and past decisions. If slots are empty,',
  'this is a new project — ask the user about it and save what you learn.',
  '',
  'Before answering questions about the project, architecture, or past decisions,',
  'search SynaptoMind first. Use memory_recall (action=search), memory_recall (action=context),',
  'or memory_recall (action=clusters) to check if this was discussed before.',
  'Do not guess when you can look it up.',
  '',
  'When creating, searching, or listing thoughts, always pass the cwd parameter',
  '(current working directory) so SynaptoMind auto-resolves the correct project.',
  'Do not hardcode project_id — use cwd instead.',
  '',
  'When the conversation reaches a conclusion, a decision is made, a problem is',
  'solved, or an idea comes up — save it. Use memory_store (action=create) to capture it',
  'with relevant tags. If it relates to existing thoughts, link them with memory_store (action=link).',
  '',
  'After completing a meaningful block of work — a decision, a task, an',
  'architectural choice — call memory_reflect (action=reflect) to record the outcome. Do not',
  'wait for the session to "end"; reflect at natural breakpoints.',
  '',
  'If you find duplicate or outdated thoughts during a search, merge them with',
  'memory_supersede (action=merge). If a thought\'s content has changed, update it with memory_store (action=update).',
  '',
  'When the user asks what to work on next, or when you finish a task and are',
  'unsure what comes next, use memory_status (action=frontier).',
  '',
  'Do not treat a missing memory server as empty memory. If SynaptoMind is',
  'unavailable, say so explicitly.',
].join('\n')

function loadInstructions(): string | undefined {
  const file = config.mcp.instructionsFile
  if (!file) return defaultInstructions
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    console.error(`[synaptomind] instructionsFile not found: ${file}, using defaults`)
    return defaultInstructions
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'synaptomind',
      version: VERSION
    },
    {
      instructions: loadInstructions()
    }
  )

  registerAllMemoryTools(server)

  return server
}
