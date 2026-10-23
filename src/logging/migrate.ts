import { Database } from 'bun:sqlite'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from '../config'
import { Logger, type LogLevel } from './log'

export interface MigrateResult {
  rows: number
  source: string
  marker: string
}

export interface MigrateOpts {
  source?: string
  sourcePath?: string
  path?: string
  force?: boolean
}

interface LegacyRow {
  id: string
  level: string
  type: string
  message: string
  metadata: string | null
  source: string | null
  error: string | null
  created_at: string
}

function isEnvEnabled(): boolean {
  const v = process.env.SYNAPTOMIND_MIGRATE_LOGS_DB
  if (v === undefined) return true
  return !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { raw }
  }
}

export function migrateLogsDb(opts?: MigrateOpts | string): MigrateResult | null {
  const resolvedOpts: MigrateOpts = typeof opts === 'string' ? { source: opts } : (opts ?? {})
  const force = resolvedOpts.force === true

  if (!force && !isEnvEnabled()) return null

  const sourceInput = resolvedOpts.source ?? resolvedOpts.sourcePath ?? resolvedOpts.path ?? config.logDbPath ?? ''
  if (!sourceInput) return null

  const source = resolve(sourceInput)
  if (!existsSync(source)) return null

  const marker = `${source}.migrated`
  if (existsSync(marker) && !force) return null

  let db: Database | null = null
  let prevDebug: string | undefined
  let touchedDebug = false
  try {
    db = new Database(source, { readonly: true })
    // Probe the table exists before querying.
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'`)
      .get() as { name: string } | undefined
    if (!table) return null

    const rows = db
      .prepare(
        `SELECT id, level, type, message, metadata, source, error, created_at
         FROM logs ORDER BY created_at, id`
      )
      .all() as LegacyRow[]

    // Emit to streams/file only — never back into logs.db (forward-only, no source mutation).
    // Preserve the full audit trail regardless of the current level floor / debug gate.
    prevDebug = process.env.SYNAPTOMIND_DEBUG
    process.env.SYNAPTOMIND_DEBUG = 'true'
    touchedDebug = true
    const logger = new Logger({ logDbPath: '', level: 'debug' })

    let count = 0
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata)
      const merged: Record<string, unknown> | undefined =
        row.error
          ? { ...(metadata ?? {}), error: row.error }
          : metadata

      logger.insertLog(
        (row.level as LogLevel) ?? 'info',
        row.type ?? 'log',
        row.message ?? '',
        merged,
        row.source ?? 'synaptomind',
        row.created_at || undefined
      )
      count++
    }

    writeFileSync(marker, `${new Date().toISOString()} ${count}\n`)
    return { rows: count, source, marker }
  } catch (e) {
    try {
      process.stderr.write(`[logs] migrateLogsDb failed: ${e}\n`)
    } catch {
      /* ignore */
    }
    return null
  } finally {
    if (touchedDebug) {
      if (prevDebug === undefined) delete process.env.SYNAPTOMIND_DEBUG
      else process.env.SYNAPTOMIND_DEBUG = prevDebug
    }
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
}