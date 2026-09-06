import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'fs'
import { config } from '../config'
import { VERSION } from '../version'
import { registerAllMemoryTools } from './tools'

export const defaultInstructions = [
  'SynaptoMind is persistent, AI-native memory for durable knowledge.',
  'It is designed to be read, maintained, and evolved primarily by AI agents.',
  '',
  'At the start of a session, load project context with memory_status (action=slots)',
  'to understand the current goals, pending work, and past decisions. If slots are empty,',
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
  'When the user asks what to work on next, or when you finish a task and are',
  'unsure what comes next, use memory_status (action=frontier).',
  '',
  'Do not treat a missing memory server as empty memory. If SynaptoMind is',
  'unavailable, say so explicitly.',
  '',
  '═══ THOUGHT QUALITY ═══',
  '',
  `Write thought content in the configured canonical content language (${config.contentLanguage} by default),`,
  'regardless of the conversation language. Preserve names, identifiers, code, quotations,',
  'and domain terms whose translation would change or lose meaning.',
  '',
  'Capture durable knowledge rather than conversation transcripts. Normalize conversational',
  'input by removing filler, repetition, and context-only references without changing meaning.',
  '',
  'Store one independently useful semantic unit per thought. Make its subject, scope,',
  'conditions, and meaning understandable outside the source conversation. Keep necessary',
  'evidence, reasoning, assumptions, constraints, and limitations with the knowledge they qualify.',
  '',
  'Preserve epistemic state and source intent. Do not silently turn uncertainty into certainty,',
  'a hypothesis into a fact, a proposal into a decision, an observation into a universal rule,',
  'or an agent interpretation into a user statement.',
  '',
  '═══ MEMORY BEHAVIOR ═══',
  '',
  'Before creating durable knowledge, search active knowledge with memory_recall.',
  'Also search draft or archived knowledge explicitly when incomplete or historical',
  'knowledge could affect the decision.',
  '',
  'Then choose the appropriate operation:',
  '- create: the knowledge is genuinely new and independently useful',
  '- update: the same knowledge has materially evolved and preserving previous wording is unnecessary',
  '- merge: multiple thoughts represent the same durable knowledge (memory_supersede action=merge)',
  '- archive: knowledge is no longer current and no replacement needs to be recorded (memory_supersede action=archive)',
  '- record supersession: create or update the current thought, link it to the obsolete one',
  '  with memory_store action=link and edge_type=replaces, then archive the obsolete thought',
  '- link: the relationship between distinct thoughts carries useful semantic information',
  '',
  'Keep lifecycle status (draft, active, archived) separate from semantic type.',
  'Use tags consistently when a distinction matters: decision, fact, observation,',
  'hypothesis, proposal, TODO, constraint, pending. Do not use status as a substitute.',
  'An active TODO or active hypothesis is valid.',
  '',
  'Create an edge only when the relationship itself carries useful information.',
  'Prefer the most specific supported edge type. Do not create related edges',
  'merely to improve connectivity or because thoughts share a broad topic.',
  '',
  'Treat memory as evolving knowledge. When new information supersedes existing knowledge,',
  'maintain the previous state so obsolete and current knowledge are distinguishable.',
  'Use a new thought plus replaces rather than in-place update when preserving that evolution matters.',
  '',
  'After completing a meaningful block of work — a decision, a task, an',
  'architectural choice — call memory_reflect (action=reflect) to record the outcome.',
  'Do not wait for the session to end; reflect at natural breakpoints.',
].join('\n')

export function loadInstructions(): string | undefined {
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
