import type { Database } from 'bun:sqlite'
import type { DuplicateContent, StaleDraft, TestRemnant, TooShortThought, UntaggedThought } from './types'
import { THOUGHTS, regularThoughtsWhere } from './query-builder'

export function findDuplicateContent(db: Database): DuplicateContent[] {
  const rows = db.prepare(`
    SELECT a.id AS id_a, b.id AS id_b, a.content AS content_a, b.content AS content_b
    FROM thoughts a
    JOIN thoughts b ON a.id < b.id
      AND a.content = b.content
      AND length(a.content) > 10
    WHERE a.status != 'archived' AND b.status != 'archived'
  `).all() as Array<{ id_a: string; id_b: string; content_a: string; content_b: string }>
  return rows.map(r => ({ ...r, similarity: 1.0 }))
}

export function findTooShort(db: Database, minLength: number = 10): TooShortThought[] {
  return db.prepare(`
    SELECT t.id, t.content, length(t.content) AS length FROM ${THOUGHTS}
    WHERE length(t.content) < ? AND ${regularThoughtsWhere()}
  `).all(minLength) as TooShortThought[]
}

export function findTestRemnants(db: Database): TestRemnant[] {
  return db.prepare(`
    SELECT t.id, t.content FROM ${THOUGHTS}
    WHERE ${regularThoughtsWhere()}
      AND t.status != 'archived'
      AND length(t.content) <= 120
      AND (
        t.content GLOB '*[Tt]est*[Tt]hought*'
        OR t.content = 'Hello from SynaptoMind!'
        OR t.content LIKE 'Test %'
        OR t.content LIKE 'test %'
      )
  `).all() as TestRemnant[]
}

export function findStaleDrafts(db: Database, days: number = 30): StaleDraft[] {
  return db.prepare(`
    SELECT t.id, t.content, t.created_at,
      CAST((julianday('now') - julianday(t.created_at)) AS INTEGER) AS age_days
    FROM ${THOUGHTS}
    WHERE t.status = 'draft'
      AND ${regularThoughtsWhere()}
      AND julianday('now') - julianday(t.created_at) > ?
    ORDER BY t.created_at ASC
  `).all(days) as StaleDraft[]
}

export function findUntagged(db: Database): UntaggedThought[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status FROM ${THOUGHTS}
    WHERE ${regularThoughtsWhere('active')}
      AND NOT EXISTS (
        SELECT 1 FROM thought_tags tt WHERE tt.thought_id = t.id
      )
  `).all() as UntaggedThought[]
}
