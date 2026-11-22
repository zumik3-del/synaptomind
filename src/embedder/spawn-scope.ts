import { config } from '../config'

export const EMBEDDER_USERS_ENV = 'SYNAPTOMIND_EMBEDDER_USERS'
export const EMBEDDER_BATCH_WORKER_ENV = 'SYNAPTOMIND_EMBEDDER_BATCH_WORKER'

// Read with literal keys so src/config.raw-env.test.ts can see them; the constants are for writing.

export interface EmbedderUserDb {
  id: string
  dbPath: string
}

// The parent's own decision (src/index.ts): a stdio session without --stdio-standalone delegates the
// embedder and the background jobs to the shared server.
export function processOwnsBackgroundJobs(argv: readonly string[] = process.argv): boolean {
  const isStdio = argv.includes('--stdio')
  const stdioStandalone =
    argv.includes('--stdio-standalone') || config.mcp?.stdioStandalone === true
  return !isStdio || stdioStandalone
}

// null = the parent handed no list (standalone or single-database child): fall back to config.users.
export function readEmbedderUsers(): EmbedderUserDb[] | null {
  const raw = process.env.SYNAPTOMIND_EMBEDDER_USERS
  if (raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.flatMap(entry => {
      const candidate = entry as { id?: unknown; dbPath?: unknown }
      return typeof candidate.id === 'string' && typeof candidate.dbPath === 'string'
        ? [{ id: candidate.id, dbPath: candidate.dbPath }]
        : []
    })
  } catch {
    return null
  }
}

export function batchWorkerEnabled(): boolean {
  return process.env.SYNAPTOMIND_EMBEDDER_BATCH_WORKER !== 'false'
}
