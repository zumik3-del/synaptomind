import type { Database } from 'bun:sqlite'

// Global DB singleton — deliberate design choice.
// SQLite is single-writer by design; this module enforces one connection
// shared across all service functions. Functions accept `Database` as a
// default parameter for test injection, but production always uses this singleton.
let db: Database | null = null

export function setDb(database: Database): void {
  db = database
}

export function getDb(): Database {
  if (!db) throw new Error('DB not initialized. Call initDb() first.')
  return db
}

export function clearDb(): void {
  db = null
}
