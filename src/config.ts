import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

interface Config {
  contentLanguage: string
  server: { port: number; host: string }
  mcp: {
    httpPort: number; instructionsFile?: string; stdioStandalone: boolean; corsOrigins: string[]
    maxSessions: number; sessionTtlMs: number; keepAliveMs: number; maxEventsPerSession: number
  }
  db: { path: string; busyTimeout: number }
  logDbPath: string
  embedder: {
    enabled: boolean; model: string; dimensions: number; pollIntervalMs: number;
    cacheDir: string; idleTimeoutMs: number; precache: boolean; batchSize: number;
    resetDeadLetters: boolean
  }
  thoughts: { softLimit: number; hardLimitBufferPercent: number }
  decay: {
    rate: number; archiveThreshold: number;
    archiveMinAgeDays: number; intervalMs: number
  }
  primer: { promoteThreshold: number; topN: number }
  verify: { enabled: boolean; driftThreshold: number; staleWarnDays: number }
  autoCluster: {
    minAgeDays: number; minSimilarity: number;
    minMembers: number; dryRun: boolean
  }
  autoLink: {
    minSimilarity: number; maxEdgesPerRun: number; dryRun: boolean
  }
  edgeDetect: {
    minSimilarity: number; topK: number; maxCandidates: number;
    maxProposals: number
  }
  placement: {
    maxClusterSize: number; proposalTtlDays: number; maxPendingProposals: number
  }
  triage: {
    enabled: boolean; maxItemsPerRun: number; maxArchivesPerRun: number;
    maxLinksPerRun: number; requireDryRunFirst: boolean; backfillEnabled: boolean
  }
  selfImprove: {
    enabled: boolean; intervalMs: number; orphanThreshold: number;
    activationThreshold: number; hitsThreshold: number;
    maxMergesPerRun: number; maxPromotesPerRun: number;
    maxPrimerPromotesPerRun: number
  }
  slots: { defaultMaxChars: number; hardLimit: number }
  graph: { maxDegree: number }
  search: { confidence: { vectorFloor: number } }
  rateLimit: { max: number; windowMs: number; trustProxy: boolean }
  ttl: { archivedTtlDays: number; cleanupIntervalMs: number }
}

export const DEFAULTS: Config = {
  contentLanguage: 'en',
  server: { port: 3005, host: '127.0.0.1' },
  mcp: {
    httpPort: 3006, instructionsFile: '', stdioStandalone: false, corsOrigins: [],
    maxSessions: 100, sessionTtlMs: 3600_000, keepAliveMs: 10_000, maxEventsPerSession: 1000
  },
  db: { path: './data/synaptomind.db', busyTimeout: 5000 },
  logDbPath: '',
  embedder: {
    enabled: true, model: 'Xenova/multilingual-e5-small', dimensions: 384,
    pollIntervalMs: 7000, cacheDir: './data/huggingface',
    idleTimeoutMs: 600000, precache: false, batchSize: 8,
    resetDeadLetters: false
  },
  thoughts: { softLimit: 600, hardLimitBufferPercent: 20 },
  decay: {
    rate: 0.95, archiveThreshold: 0.1,
    archiveMinAgeDays: 30, intervalMs: 86400000
  },
  primer: { promoteThreshold: 5, topN: 3 },
  verify: { enabled: true, driftThreshold: 0.25, staleWarnDays: 30 },
  // `minSimilarity` is compared against vec0's cosine DISTANCE (see
  // auto-cluster.service.ts `r.distance < minSimilarity`), so lower = tighter.
  // 0.3 chained the whole active graph into one 1122-member mega-cluster via
  // Union-Find transitive closure; 0.09 is the calibrated value for e5-small
  // cosine distance (ADR 2026-09-28, thought 01a094b2-…).
  autoCluster: {
    minAgeDays: 3, minSimilarity: 0.09,
    minMembers: 3, dryRun: false
  },
  autoLink: {
    minSimilarity: 0.65, maxEdgesPerRun: 20, dryRun: false
  },
  edgeDetect: {
    minSimilarity: 0.75, topK: 10, maxCandidates: 100,
    maxProposals: 20
  },
  // Skip a cluster proposal once a cluster already holds this many members:
  // prevents feeding the mega-cluster defect (lessons #934/#928). Read-only
  // proposer — the cap only suppresses the suggestion, it never mutates.
  // `proposalTtlDays` bounds the review queue (ADR §2.4): terminal rows are
  // pruned after the TTL and live `pending` rows use `expires_at`.
  placement: { maxClusterSize: 50, proposalTtlDays: 30, maxPendingProposals: 500 },
  // Draft-triage per-run caps (ADR 2026-09-29 §2.7/§2.8). `maxLinksPerRun`
  // mirrors `autoLink.maxEdgesPerRun` (phase-2 link proposals), and
  // `requireDryRunFirst` forces a preview before a run may confirm.
  triage: {
    enabled: true, maxItemsPerRun: 25, maxArchivesPerRun: 25,
    maxLinksPerRun: 20, requireDryRunFirst: true, backfillEnabled: true
  },
  selfImprove: {
    enabled: false, intervalMs: 86400000, orphanThreshold: 0.5,
    activationThreshold: 0.3, hitsThreshold: 5,
    maxMergesPerRun: 3, maxPromotesPerRun: 5,
    maxPrimerPromotesPerRun: 3
  },
  slots: { defaultMaxChars: 2000, hardLimit: 20000 },
  graph: { maxDegree: 50 },
  // Conservative placeholder pending issue #156 calibration: above the observed
  // nonsense band so noise is never marked confident. Re-derive from a labeled
  // real-embedder run; override with SYNAPTOMIND_SEARCH_CONFIDENCE_VECTOR_FLOOR.
  // Single source of truth for the DB-layer fallback in `src/db/search.ts` (which
  // reads `DEFAULTS.search.confidence.vectorFloor` directly — keep them in sync).
  search: { confidence: { vectorFloor: 0.9 } },
  rateLimit: { max: 200, windowMs: 60_000, trustProxy: false },
  ttl: { archivedTtlDays: 90, cleanupIntervalMs: 86400000 }
}

type EnvType = 'string' | 'int' | 'float' | 'bool' | 'list'

interface EnvMapping {
  env: string
  path: string
  type: EnvType
}

const M = (env: string, path: string, type: EnvType): EnvMapping => ({ env, path, type })

export const ENV_MAPPINGS: EnvMapping[] = [
  M('SYNAPTOMIND_CONTENT_LANGUAGE', 'contentLanguage', 'string'),

  M('SYNAPTOMIND_PORT', 'server.port', 'int'),
  M('SYNAPTOMIND_HOST', 'server.host', 'string'),

  M('SYNAPTOMIND_MCP_HTTP_PORT', 'mcp.httpPort', 'int'),
  M('SYNAPTOMIND_MCP_INSTRUCTIONS_FILE', 'mcp.instructionsFile', 'string'),
  M('SYNAPTOMIND_MCP_STDIO_STANDALONE', 'mcp.stdioStandalone', 'bool'),
  M('SYNAPTOMIND_MCP_CORS_ORIGINS', 'mcp.corsOrigins', 'list'),
  M('SYNAPTOMIND_MCP_MAX_SESSIONS', 'mcp.maxSessions', 'int'),
  M('SYNAPTOMIND_MCP_SESSION_TTL_MS', 'mcp.sessionTtlMs', 'int'),
  M('SYNAPTOMIND_MCP_KEEPALIVE_MS', 'mcp.keepAliveMs', 'int'),
  M('SYNAPTOMIND_MCP_MAX_EVENTS_PER_SESSION', 'mcp.maxEventsPerSession', 'int'),

  M('SYNAPTOMIND_DB_PATH', 'db.path', 'string'),
  M('SYNAPTOMIND_DB_BUSY_TIMEOUT', 'db.busyTimeout', 'int'),
  M('SYNAPTOMIND_LOG_DB_PATH', 'logDbPath', 'string'),

  M('SYNAPTOMIND_EMBEDDER_MODEL', 'embedder.model', 'string'),
  M('SYNAPTOMIND_EMBEDDER_ENABLED', 'embedder.enabled', 'bool'),
  M('SYNAPTOMIND_EMBEDDER_DIMENSIONS', 'embedder.dimensions', 'int'),
  M('SYNAPTOMIND_EMBEDDER_POLL_INTERVAL', 'embedder.pollIntervalMs', 'int'),
  M('SYNAPTOMIND_EMBEDDER_CACHE_DIR', 'embedder.cacheDir', 'string'),
  M('SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT', 'embedder.idleTimeoutMs', 'int'),
  M('SYNAPTOMIND_EMBEDDER_PRECACHE', 'embedder.precache', 'bool'),
  M('SYNAPTOMIND_EMBEDDER_BATCH_SIZE', 'embedder.batchSize', 'int'),
  M('SYNAPTOMIND_RESET_DEAD_LETTER', 'embedder.resetDeadLetters', 'bool'),

  M('SYNAPTOMIND_THOUGHT_SOFT_LIMIT', 'thoughts.softLimit', 'int'),
  M('SYNAPTOMIND_THOUGHT_HARD_LIMIT_BUFFER_PERCENT', 'thoughts.hardLimitBufferPercent', 'int'),

  M('SYNAPTOMIND_DECAY_RATE', 'decay.rate', 'float'),
  M('SYNAPTOMIND_ARCHIVE_THRESHOLD', 'decay.archiveThreshold', 'float'),
  M('SYNAPTOMIND_ARCHIVE_MIN_AGE_DAYS', 'decay.archiveMinAgeDays', 'int'),
  M('SYNAPTOMIND_DECAY_INTERVAL_MS', 'decay.intervalMs', 'int'),

  M('SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD', 'primer.promoteThreshold', 'int'),
  M('SYNAPTOMIND_PRIMER_TOP_N', 'primer.topN', 'int'),

  M('SYNAPTOMIND_VERIFY_ENABLED', 'verify.enabled', 'bool'),
  M('SYNAPTOMIND_DRIFT_THRESHOLD', 'verify.driftThreshold', 'float'),
  M('SYNAPTOMIND_STALE_WARN_DAYS', 'verify.staleWarnDays', 'int'),

  M('SYNAPTOMIND_AUTO_CLUSTER_MIN_AGE_DAYS', 'autoCluster.minAgeDays', 'int'),
  M('SYNAPTOMIND_AUTO_CLUSTER_MIN_SIMILARITY', 'autoCluster.minSimilarity', 'float'),
  M('SYNAPTOMIND_AUTO_CLUSTER_MIN_MEMBERS', 'autoCluster.minMembers', 'int'),
  M('SYNAPTOMIND_AUTO_CLUSTER_DRY_RUN', 'autoCluster.dryRun', 'bool'),

  M('SYNAPTOMIND_AUTO_LINK_MIN_SIMILARITY', 'autoLink.minSimilarity', 'float'),
  M('SYNAPTOMIND_AUTO_LINK_MAX_EDGES', 'autoLink.maxEdgesPerRun', 'int'),
  M('SYNAPTOMIND_AUTO_LINK_DRY_RUN', 'autoLink.dryRun', 'bool'),

  M('SYNAPTOMIND_EDGE_DETECT_MIN_SIMILARITY', 'edgeDetect.minSimilarity', 'float'),
  M('SYNAPTOMIND_EDGE_DETECT_TOP_K', 'edgeDetect.topK', 'int'),
  M('SYNAPTOMIND_EDGE_DETECT_MAX_CANDIDATES', 'edgeDetect.maxCandidates', 'int'),
  M('SYNAPTOMIND_EDGE_DETECT_MAX_PROPOSALS', 'edgeDetect.maxProposals', 'int'),

  M('SYNAPTOMIND_PLACEMENT_MAX_CLUSTER_SIZE', 'placement.maxClusterSize', 'int'),
  M('SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS', 'placement.proposalTtlDays', 'int'),
  M('SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS', 'placement.maxPendingProposals', 'int'),

  M('SYNAPTOMIND_TRIAGE_ENABLED', 'triage.enabled', 'bool'),
  M('SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN', 'triage.maxItemsPerRun', 'int'),
  M('SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN', 'triage.maxArchivesPerRun', 'int'),
  M('SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN', 'triage.maxLinksPerRun', 'int'),
  M('SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST', 'triage.requireDryRunFirst', 'bool'),
  M('SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED', 'triage.backfillEnabled', 'bool'),

  M('SYNAPTOMIND_SELF_IMPROVE_ENABLED', 'selfImprove.enabled', 'bool'),
  M('SYNAPTOMIND_SELF_IMPROVE_INTERVAL_MS', 'selfImprove.intervalMs', 'int'),
  M('SYNAPTOMIND_SELF_IMPROVE_ORPHAN_THRESHOLD', 'selfImprove.orphanThreshold', 'float'),
  M('SYNAPTOMIND_SELF_IMPROVE_ACTIVATION_THRESHOLD', 'selfImprove.activationThreshold', 'float'),
  M('SYNAPTOMIND_SELF_IMPROVE_HITS_THRESHOLD', 'selfImprove.hitsThreshold', 'int'),
  M('SYNAPTOMIND_SELF_IMPROVE_MAX_MERGES', 'selfImprove.maxMergesPerRun', 'int'),
  M('SYNAPTOMIND_SELF_IMPROVE_MAX_PROMOTES', 'selfImprove.maxPromotesPerRun', 'int'),
  M('SYNAPTOMIND_SELF_IMPROVE_MAX_PRIMER_PROMOTES', 'selfImprove.maxPrimerPromotesPerRun', 'int'),

  M('SYNAPTOMIND_SLOTS_MAX_CHARS', 'slots.defaultMaxChars', 'int'),
  M('SYNAPTOMIND_SLOTS_HARD_LIMIT', 'slots.hardLimit', 'int'),

  M('SYNAPTOMIND_GRAPH_MAX_DEGREE', 'graph.maxDegree', 'int'),

  M('SYNAPTOMIND_SEARCH_CONFIDENCE_VECTOR_FLOOR', 'search.confidence.vectorFloor', 'float'),

  M('SYNAPTOMIND_RATE_LIMIT', 'rateLimit.max', 'int'),
  M('SYNAPTOMIND_RATE_LIMIT_WINDOW_MS', 'rateLimit.windowMs', 'int'),
  M('SYNAPTOMIND_TRUST_PROXY', 'rateLimit.trustProxy', 'bool'),

  M('SYNAPTOMIND_ARCHIVED_TTL_DAYS', 'ttl.archivedTtlDays', 'int'),
  M('SYNAPTOMIND_CLEANUP_INTERVAL_MS', 'ttl.cleanupIntervalMs', 'int')
]

function parseValue(raw: string, type: EnvType): string | number | boolean | string[] {
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
    case 'list': return raw.split(',').map(s => s.trim()).filter(Boolean)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(current[keys[i]])) current[keys[i]] = {}
    current = current[keys[i]] as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const s = source[key]
    const t = target[key]
    result[key] = isPlainObject(s) && isPlainObject(t) ? deepMerge(t, s) : s
  }
  return result
}

function loadFileConfig(): Partial<Config> {
  const configPath = join(process.cwd(), 'config.json')
  if (!existsSync(configPath)) {
    console.error(`[synaptomind] config.json not found at ${configPath}, using defaults`)
    return {}
  }
  const stat = statSync(configPath)
  if (stat.isDirectory()) {
    console.error(`[synaptomind] config.json at ${configPath} is a directory, not a file.`)
    console.error('[synaptomind] Run: cp config.json.example config.json')
    throw new Error(`Invalid config.json at ${configPath}: it is a directory, not a file`)
  }
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<Config>
}

function applyEnvOverrides(fileConfig: Partial<Config>): Config {
  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileConfig as unknown as Record<string, unknown>
  )

  for (const { env, path, type } of ENV_MAPPINGS) {
    const raw = process.env[env]
    if (raw === undefined) continue
    const value = parseValue(raw, type)
    if (typeof value === 'number' && Number.isNaN(value)) {
      console.error(`[config] invalid value for ${env}: "${raw}" (expected ${type}), using default`)
      continue
    }
    setNested(merged, path, value)
  }

  return merged as unknown as Config
}

export const config: Config = applyEnvOverrides(loadFileConfig())
