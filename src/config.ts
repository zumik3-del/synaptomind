import { readFileSync, statSync } from 'fs'
import { join } from 'path'

interface Config {
  contentLanguage: string
  server: { port: number; host: string }
  mcp: { httpPort: number; instructionsFile?: string }
  db: { path: string; busyTimeout: number }
  logDbPath: string
  embedder: {
    enabled: boolean; model: string; dimensions: number; pollIntervalMs: number;
    cacheDir: string; idleTimeoutMs: number; precache: boolean; batchSize: number
  }
  thoughts: { softLimit: number; hardLimit: number }
  decay: {
    rate: number; archiveThreshold: number;
    archiveMinAgeDays: number; intervalMs: number
  }
  smartNotes: { autoPromote: boolean; evalIntervalMs: number }
  primer: { promoteThreshold: number; topN: number }
  verify: { enabled: boolean; driftThreshold: number; staleWarnDays: number }
  autoCluster: {
    minAgeDays: number; minSimilarity: number;
    minMembers: number; dryRun: boolean
  }
  autoLink: {
    minSimilarity: number; maxEdgesPerRun: number;
    minEntityOverlap: number; dryRun: boolean
  }
  selfImprove: {
    enabled: boolean; intervalMs: number; orphanThreshold: number;
    activationThreshold: number; hitsThreshold: number;
    maxMergesPerRun: number; maxPromotesPerRun: number;
    maxPrimerPromotesPerRun: number
  }
  slots: { defaultMaxChars: number; hardLimit: number }
  graph: { maxDegree: number }
  rateLimit: { max: number; windowMs: number }
  ttl: { archivedTtlDays: number; cleanupIntervalMs: number }
}

export const DEFAULTS: Config = {
  contentLanguage: 'en',
  server: { port: 3005, host: '127.0.0.1' },
  mcp: { httpPort: 3006, instructionsFile: '' },
  db: { path: './data/synaptomind.db', busyTimeout: 5000 },
  logDbPath: '',
  embedder: {
    enabled: true, model: 'Xenova/multilingual-e5-small', dimensions: 384,
    pollIntervalMs: 7000, cacheDir: './data/huggingface',
    idleTimeoutMs: 600000, precache: false, batchSize: 8
  },
  thoughts: { softLimit: 500, hardLimit: 600 },
  decay: {
    rate: 0.95, archiveThreshold: 0.1,
    archiveMinAgeDays: 30, intervalMs: 86400000
  },
  smartNotes: { autoPromote: false, evalIntervalMs: 3600000 },
  primer: { promoteThreshold: 5, topN: 3 },
  verify: { enabled: true, driftThreshold: 0.25, staleWarnDays: 30 },
  autoCluster: {
    minAgeDays: 3, minSimilarity: 0.3,
    minMembers: 3, dryRun: false
  },
  autoLink: {
    minSimilarity: 0.65, maxEdgesPerRun: 20,
    minEntityOverlap: 1, dryRun: false
  },
  selfImprove: {
    enabled: false, intervalMs: 86400000, orphanThreshold: 0.5,
    activationThreshold: 0.3, hitsThreshold: 5,
    maxMergesPerRun: 3, maxPromotesPerRun: 5,
    maxPrimerPromotesPerRun: 3
  },
  slots: { defaultMaxChars: 2000, hardLimit: 20000 },
  graph: { maxDegree: 50 },
  rateLimit: { max: 200, windowMs: 60_000 },
  ttl: { archivedTtlDays: 90, cleanupIntervalMs: 86400000 }
}

export type EnvType = 'string' | 'int' | 'float' | 'bool'

export interface EnvMapping {
  env: string
  path: string
  type: EnvType
}

export const ENV_MAPPINGS: EnvMapping[] = [
  { env: 'SYNAPTOMIND_CONTENT_LANGUAGE', path: 'contentLanguage', type: 'string' },

  { env: 'SYNAPTOMIND_PORT', path: 'server.port', type: 'int' },
  { env: 'SYNAPTOMIND_HOST', path: 'server.host', type: 'string' },

  { env: 'SYNAPTOMIND_MCP_HTTP_PORT', path: 'mcp.httpPort', type: 'int' },
  { env: 'SYNAPTOMIND_MCP_INSTRUCTIONS_FILE', path: 'mcp.instructionsFile', type: 'string' },

  { env: 'SYNAPTOMIND_DB_PATH', path: 'db.path', type: 'string' },
  { env: 'SYNAPTOMIND_DB_BUSY_TIMEOUT', path: 'db.busyTimeout', type: 'int' },
  { env: 'SYNAPTOMIND_LOG_DB_PATH', path: 'logDbPath', type: 'string' },

  { env: 'SYNAPTOMIND_EMBEDDER_MODEL', path: 'embedder.model', type: 'string' },
  { env: 'SYNAPTOMIND_EMBEDDER_ENABLED', path: 'embedder.enabled', type: 'bool' },
  { env: 'SYNAPTOMIND_EMBEDDER_DIMENSIONS', path: 'embedder.dimensions', type: 'int' },
  { env: 'SYNAPTOMIND_EMBEDDER_POLL_INTERVAL', path: 'embedder.pollIntervalMs', type: 'int' },
  { env: 'SYNAPTOMIND_EMBEDDER_CACHE_DIR', path: 'embedder.cacheDir', type: 'string' },
  { env: 'SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT', path: 'embedder.idleTimeoutMs', type: 'int' },
  { env: 'SYNAPTOMIND_EMBEDDER_PRECACHE', path: 'embedder.precache', type: 'bool' },
  { env: 'SYNAPTOMIND_EMBEDDER_BATCH_SIZE', path: 'embedder.batchSize', type: 'int' },

  { env: 'SYNAPTOMIND_THOUGHT_SOFT_LIMIT', path: 'thoughts.softLimit', type: 'int' },
  { env: 'SYNAPTOMIND_THOUGHT_HARD_LIMIT', path: 'thoughts.hardLimit', type: 'int' },

  { env: 'SYNAPTOMIND_DECAY_RATE', path: 'decay.rate', type: 'float' },
  { env: 'SYNAPTOMIND_ARCHIVE_THRESHOLD', path: 'decay.archiveThreshold', type: 'float' },
  { env: 'SYNAPTOMIND_ARCHIVE_MIN_AGE_DAYS', path: 'decay.archiveMinAgeDays', type: 'int' },
  { env: 'SYNAPTOMIND_DECAY_INTERVAL_MS', path: 'decay.intervalMs', type: 'int' },

  { env: 'SYNAPTOMIND_SMART_NOTES_AUTO_PROMOTE', path: 'smartNotes.autoPromote', type: 'bool' },
  { env: 'SYNAPTOMIND_SMART_NOTES_EVAL_INTERVAL', path: 'smartNotes.evalIntervalMs', type: 'int' },

  { env: 'SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD', path: 'primer.promoteThreshold', type: 'int' },
  { env: 'SYNAPTOMIND_PRIMER_TOP_N', path: 'primer.topN', type: 'int' },

  { env: 'SYNAPTOMIND_VERIFY_ENABLED', path: 'verify.enabled', type: 'bool' },
  { env: 'SYNAPTOMIND_DRIFT_THRESHOLD', path: 'verify.driftThreshold', type: 'float' },
  { env: 'SYNAPTOMIND_STALE_WARN_DAYS', path: 'verify.staleWarnDays', type: 'int' },

  { env: 'SYNAPTOMIND_AUTO_CLUSTER_MIN_AGE_DAYS', path: 'autoCluster.minAgeDays', type: 'int' },
  { env: 'SYNAPTOMIND_AUTO_CLUSTER_MIN_SIMILARITY', path: 'autoCluster.minSimilarity', type: 'float' },
  { env: 'SYNAPTOMIND_AUTO_CLUSTER_MIN_MEMBERS', path: 'autoCluster.minMembers', type: 'int' },
  { env: 'SYNAPTOMIND_AUTO_CLUSTER_DRY_RUN', path: 'autoCluster.dryRun', type: 'bool' },

  { env: 'SYNAPTOMIND_AUTO_LINK_MIN_SIMILARITY', path: 'autoLink.minSimilarity', type: 'float' },
  { env: 'SYNAPTOMIND_AUTO_LINK_MAX_EDGES', path: 'autoLink.maxEdgesPerRun', type: 'int' },
  { env: 'SYNAPTOMIND_AUTO_LINK_MIN_ENTITY_OVERLAP', path: 'autoLink.minEntityOverlap', type: 'int' },
  { env: 'SYNAPTOMIND_AUTO_LINK_DRY_RUN', path: 'autoLink.dryRun', type: 'bool' },

  { env: 'SYNAPTOMIND_SELF_IMPROVE_ENABLED', path: 'selfImprove.enabled', type: 'bool' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_INTERVAL_MS', path: 'selfImprove.intervalMs', type: 'int' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_ORPHAN_THRESHOLD', path: 'selfImprove.orphanThreshold', type: 'float' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_ACTIVATION_THRESHOLD', path: 'selfImprove.activationThreshold', type: 'float' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_HITS_THRESHOLD', path: 'selfImprove.hitsThreshold', type: 'int' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_MAX_MERGES', path: 'selfImprove.maxMergesPerRun', type: 'int' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_MAX_PROMOTES', path: 'selfImprove.maxPromotesPerRun', type: 'int' },
  { env: 'SYNAPTOMIND_SELF_IMPROVE_MAX_PRIMER_PROMOTES', path: 'selfImprove.maxPrimerPromotesPerRun', type: 'int' },

  { env: 'SYNAPTOMIND_SLOTS_MAX_CHARS', path: 'slots.defaultMaxChars', type: 'int' },
  { env: 'SYNAPTOMIND_SLOTS_HARD_LIMIT', path: 'slots.hardLimit', type: 'int' },

  { env: 'SYNAPTOMIND_GRAPH_MAX_DEGREE', path: 'graph.maxDegree', type: 'int' },

  { env: 'SYNAPTOMIND_RATE_LIMIT', path: 'rateLimit.max', type: 'int' },
  { env: 'SYNAPTOMIND_RATE_LIMIT_WINDOW_MS', path: 'rateLimit.windowMs', type: 'int' },

  { env: 'SYNAPTOMIND_ARCHIVED_TTL_DAYS', path: 'ttl.archivedTtlDays', type: 'int' },
  { env: 'SYNAPTOMIND_CLEANUP_INTERVAL_MS', path: 'ttl.cleanupIntervalMs', type: 'int' }
]

function parseValue(raw: string, type: EnvType): string | number | boolean {
  switch (type) {
    case 'string': return raw
    case 'int': {
      const n = parseInt(raw, 10)
      return Number.isFinite(n) ? n : NaN
    }
    case 'float': {
      const n = parseFloat(raw)
      return Number.isFinite(n) ? n : NaN
    }
    case 'bool': return raw === 'true'
  }
}

function setNested(obj: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current)) current[keys[i]] = {}
    current = current[keys[i]]
  }
  current[keys[keys.length - 1]] = value
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}

function loadFileConfig(): Partial<Config> {
  const configPath = join(process.cwd(), 'config.json')
  try {
    const stat = statSync(configPath)
    if (stat.isDirectory()) {
      console.error(`[synaptomind] config.json at ${configPath} is a directory, not a file.`)
      console.error('[synaptomind] Run: cp config.json.example config.json')
      process.exit(1)
    }
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<Config>
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      console.error(`[synaptomind] config.json not found at ${configPath}, using defaults`)
      return {}
    }
    throw err
  }
}

function applyEnvOverrides(fileConfig: Partial<Config>): Config {
  const merged = deepMerge(DEFAULTS as Record<string, any>, fileConfig as Record<string, any>)

  for (const { env, path, type } of ENV_MAPPINGS) {
    const raw = process.env[env]
    if (raw === undefined) continue
    const value = parseValue(raw, type)
    if (typeof value === 'number' && Number.isNaN(value)) continue
    setNested(merged, path, value)
  }

  return merged as Config
}

export const config: Config = applyEnvOverrides(loadFileConfig())
