import type { Database } from 'bun:sqlite'

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
