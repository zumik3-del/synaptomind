import { config, DEFAULTS, ENV_MAPPINGS } from '../config'

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '-'
  if (typeof val === 'boolean') return val ? 'yes' : 'no'
  if (typeof val === 'number') return String(val)
  if (typeof val === 'string') return val || '-'
  return JSON.stringify(val)
}

function getVal(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const SECTION_LABELS: Record<string, string> = {
  contentLanguage: 'General', server: 'Server', mcp: 'MCP', db: 'Database',
  logDbPath: 'Database', embedder: 'Embedder', thoughts: 'Thoughts', decay: 'Decay',
  smartNotes: 'Smart Notes', primer: 'Primer', verify: 'Verify',
  autoCluster: 'Auto Cluster', autoLink: 'Auto Link', selfImprove: 'Self Improve',
  edgeDetect: 'Edge Detect', slots: 'Slots', git: 'Git'
}

// Filesystem layout must not leak to MCP clients: redact path-bearing settings.
const SENSITIVE_PATH_KEYS = new Set(['db.path', 'logDbPath', 'embedder.cacheDir', 'mcp.instructionsFile'])

function displayValue(path: string, val: unknown): string {
  if (SENSITIVE_PATH_KEYS.has(path)) {
    return val === null || val === undefined || val === '' ? '-' : '[redacted]'
  }
  return formatValue(val)
}

/**
 * Render the effective configuration as human-readable text for the MCP
 * `memory_status` config action. Lives in the service layer so the tool stays
 * thin (finding F11) and path-bearing settings remain redacted.
 */
export function buildConfigDisplay(): string {
  const c = config as unknown as Record<string, unknown>
  const d = DEFAULTS as unknown as Record<string, unknown>
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
