import { statSync } from 'node:fs'
import { config } from '../config'
import { getDb } from '../db'
import { getStats, type DbStats } from '../db/stats'
import type { Database } from 'bun:sqlite'

export function getStatsService(d: Database = getDb()): DbStats & { db_size_bytes: number } {
  let sizeBytes = 0
  try {
    sizeBytes = statSync(config.db.path).size
  } catch {
    // DB may be :memory: (tests) or not yet on disk
  }
  return { ...getStats(d), db_size_bytes: sizeBytes }
}
