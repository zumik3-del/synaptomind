import type { Database } from 'bun:sqlite'
import type { DuplicateContent, StaleDraft, TestRemnant, TooShortThought, UntaggedThought } from './types'

export function findDuplicateContent(db: Database): DuplicateContent[] {
  const rows = db.prepare(`
    SELECT a.id AS id_a, b.id AS id_b, a.content AS content_a, b.content AS content_b
    FROM thoughts a
    JOIN thoughts b ON a.id < b.id
      AND a.content = b.content
      AND length(a.content) > 10
  `).all() as Array<{ id_a: string; id_b: string; content_a: string; content_b: string }>
  return rows.map(r => ({ ...r, similarity: 1.0 }))
}

export function findTooShort(db: Database, minLength: number = 10): TooShortThought[] {
  return db.prepare(`
    SELECT id, content, length(content) AS length FROM thoughts
    WHERE length(content) < ? AND is_cluster = 0
  `).all(minLength) as TooShortThought[]
}

export function findTestRemnants(db: Database): TestRemnant[] {
  return db.prepare(`
    SELECT id, content FROM thoughts
    WHERE is_cluster = 0
      AND (
        content GLOB '*[Tt]est*[Tt]hought*'
        OR content = 'Hello from SynaptoMind!'
        OR content LIKE 'Test %'
        OR content LIKE 'test %'
      )
  `).all() as TestRemnant[]
}

export function findStaleDrafts(db: Database, days: number = 30): StaleDraft[] {
  return db.prepare(`
    SELECT id, content, created_at,
      CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days
    FROM thoughts
    WHERE status = 'draft'
      AND is_cluster = 0
      AND julianday('now') - julianday(created_at) > ?
    ORDER BY created_at ASC
  `).all(days) as StaleDraft[]
}

export function findUntagged(db: Database): UntaggedThought[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status FROM thoughts t
    WHERE t.status = 'active'
      AND t.is_cluster = 0
      AND NOT EXISTS (
        SELECT 1 FROM thought_tags tt WHERE tt.thought_id = t.id
      )
  `).all() as UntaggedThought[]
}
