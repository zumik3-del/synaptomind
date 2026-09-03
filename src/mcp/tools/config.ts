// IMPORTANT: MCP tool output is not always displayed in opencode terminal.
// After calling get_config, ALWAYS copy the result into your text response
// so the user can see it. The tool works correctly — this is a display limitation.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config, DEFAULTS, ENV_MAPPINGS } from '../../config'

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '-'
  if (typeof val === 'boolean') return val ? 'yes' : 'no'
  if (typeof val === 'number') return String(val)
  if (typeof val === 'string') return val || '-'
  return JSON.stringify(val)
}

function getVal(obj: Record<string, any>, path: string): unknown {
  const keys = path.split('.')
  let current = obj
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

const SECTION_LABELS: Record<string, string> = {
  contentLanguage: 'General',
  server: 'Server',
  mcp: 'MCP',
  db: 'Database',
  logDbPath: 'Database',
  embedder: 'Embedder',
  thoughts: 'Thoughts',
  decay: 'Decay',
  smartNotes: 'Smart Notes',
  primer: 'Primer',
  verify: 'Verify',
  autoCluster: 'Auto Cluster',
  autoLink: 'Auto Link',
  selfImprove: 'Self Improve',
  slots: 'Slots',
  git: 'Git'
}

function buildConfigDisplay(): string {
  const c: Record<string, any> = config as any
  const d: Record<string, any> = DEFAULTS as any

  const sections = new Map<string, Array<{ path: string; env: string }>>()

  for (const mapping of ENV_MAPPINGS) {
    const topKey = mapping.path.split('.')[0]
    const section = SECTION_LABELS[topKey] || topKey
    if (!sections.has(section)) sections.set(section, [])
    sections.get(section)!.push({ path: mapping.path, env: mapping.env })
  }

  let out = 'SynaptoMind Configuration\n'

  for (const [section, entries] of sections) {
    out += `\n--- ${section} ---\n`
    for (const { path, env } of entries) {
      const val = getVal(c, path)
      const def = getVal(d, path)
      const defNote = formatValue(def) !== formatValue(val) ? ` [default: ${formatValue(def)}]` : ''
      out += `  ${path} = ${formatValue(val)} (${env})${defNote}\n`
    }
  }

  return out
}

export function registerConfigTools(server: McpServer) {
  server.tool('get_config', 'Show current configuration with defaults and env vars', {}, async () => {
    return { content: [{ type: 'text' as const, text: buildConfigDisplay() }] }
  })
}
