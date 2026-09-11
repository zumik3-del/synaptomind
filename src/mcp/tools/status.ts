import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSlots } from '../../services/slots.service'
import { getFrontier } from '../../services/frontier.service'
import { getProfileService } from '../../services/profile.service'
import { config, DEFAULTS, ENV_MAPPINGS } from '../../config'
import { runHealthCheck } from '../../services/health-check.service'
import { cleanupArchivedThoughts } from '../../services/ttl-cleanup.service'
import { jsonResult, errorResult, resolveProjectId, toolOutputShape } from './utils'

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
  contentLanguage: 'General', server: 'Server', mcp: 'MCP', db: 'Database',
  logDbPath: 'Database', embedder: 'Embedder', thoughts: 'Thoughts', decay: 'Decay',
  smartNotes: 'Smart Notes', primer: 'Primer', verify: 'Verify',
  autoCluster: 'Auto Cluster', autoLink: 'Auto Link', selfImprove: 'Self Improve',
  slots: 'Slots', git: 'Git'
}

// Filesystem layout must not leak to MCP clients: redact path-bearing settings.
const SENSITIVE_PATH_KEYS = new Set(['db.path', 'logDbPath', 'embedder.cacheDir', 'mcp.instructionsFile'])

function displayValue(path: string, val: unknown): string {
  if (SENSITIVE_PATH_KEYS.has(path)) {
    return val === null || val === undefined || val === '' ? '-' : '[redacted]'
  }
  return formatValue(val)
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
      const val = displayValue(path, getVal(c, path))
      const def = displayValue(path, getVal(d, path))
      const defNote = def !== val ? ` [default: ${def}]` : ''
      out += `  ${path} = ${val} (${env})${defNote}\n`
    }
  }
  return out
}

export function registerMemoryStatus(server: McpServer) {
  server.registerTool('memory_status', {
    description: `Query system state. Actions:
- slots: Get context slots (persona, pending_items, architecture_decisions, project_context, active_goals)
- frontier: Get "what to do next" ranking
- profile: Get user profile stats and thoughts
- config: Show current configuration with defaults and env vars
- health: Audit graph health (broken links, orphans, duplicates, structural issues)
- cleanup: Preview expired archived thoughts based on TTL config (dry-run by default; pass dry_run=false to delete)`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'profile', 'config', 'health', 'cleanup']).optional().describe('Action (default: slots)'),
      names: z.array(z.string()).optional().describe('Filter by slot names (slots only)'),
      project_id: z.string().optional().describe('Filter by project (slots/frontier only)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (slots/frontier only)'),
      k: z.number().int().min(1).max(50).optional().describe('Max results (default 10, 1-50; frontier only)'),
      severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity (health only)'),
      fix: z.boolean().optional().describe('Auto-fix safe issues (health only)'),
      dry_run: z.boolean().optional().describe('Preview without deleting (cleanup only). Defaults to true; set false to actually delete.')
    },
    outputSchema: toolOutputShape
  }, async (args) => {
    const action = args.action ?? 'slots'

    try {
      if (action === 'slots') {
        const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
        const slots = getSlots({ names: args.names as string[] | undefined, projectId: projectFilter })
        return jsonResult(slots)
      }

      if (action === 'frontier') {
        const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
        const frontier = getFrontier({ project_id: projectFilter, k: args.k })
        return jsonResult(frontier)
      }

      if (action === 'profile') {
        const { stats, thoughts } = getProfileService()
        return jsonResult({ stats, thoughts })
      }

      if (action === 'config') {
        const text = buildConfigDisplay()
        return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } }
      }

      if (action === 'health') {
        const report = runHealthCheck({ severity: args.severity, fix: args.fix })
        return jsonResult(report)
      }

      if (action === 'cleanup') {
        const result = cleanupArchivedThoughts(args.dry_run ?? true)
        return jsonResult(result)
      }

      return errorResult(`Unknown action: ${action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_status failed')
    }
  })
}
