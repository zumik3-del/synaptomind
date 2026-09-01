import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'
import { boostImportance } from './thoughts'

export interface Primer {
  id: string
  thought_id: string
  hit_count: number
  promoted_at: string | null
  created_at: string
}

export function getPrimers(db: Database, limit = 500): Primer[] {
  return db.prepare(`SELECT * FROM primers ORDER BY hit_count DESC LIMIT ?`).all(limit) as Primer[]
}

export function getPrimerByThoughtId(db: Database, thoughtId: string): Primer | undefined {
  const row = db.prepare(`SELECT * FROM primers WHERE thought_id = ?`).get(thoughtId) as Primer | undefined | null
  return row ?? undefined
}

export function getPrimerIds(db: Database): string[] {
  const rows = db.prepare(`SELECT thought_id FROM primers`).all() as { thought_id: string }[]
  return rows.map(r => r.thought_id)
}

export function promoteThoughtToPrimer(db: Database, thoughtId: string, hitCount: number): Primer | undefined {
  const existing = getPrimerByThoughtId(db, thoughtId)
  const now = new Date().toISOString()
  if (existing) {
    db.prepare(`UPDATE primers SET hit_count = ?, promoted_at = COALESCE(promoted_at, ?) WHERE thought_id = ?`).run(
      hitCount,
      now,
      thoughtId
    )
    return getPrimerByThoughtId(db, thoughtId)
  }
  const id = uuidv7()
  db.prepare(`
    INSERT INTO primers (id, thought_id, hit_count, promoted_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, thoughtId, hitCount, now, now)
  boostImportance(db, thoughtId, 0.15)
  return getPrimerByThoughtId(db, thoughtId)
}

export function deletePrimer(db: Database, primerId: string): boolean {
  return db.prepare(`DELETE FROM primers WHERE id = ?`).run(primerId).changes > 0
}

export function attemptPromote(db: Database, thoughtId: string, hitCount: number, threshold: number): void {
  if (hitCount >= threshold && !getPrimerByThoughtId(db, thoughtId)) {
    promoteThoughtToPrimer(db, thoughtId, hitCount)
  }
}
