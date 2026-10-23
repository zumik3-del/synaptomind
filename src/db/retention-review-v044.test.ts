import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import v044 from './migrations/v044-retention-review-indexes'

test('v044 creates retention-review candidate indexes and can be applied repeatedly', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE thoughts (status TEXT, is_protected INTEGER, created_at TEXT, archived_at TEXT)`)
    db.exec(`CREATE TABLE thought_importance (importance REAL, hit_count INTEGER)`)
    v044.apply(db)
    v044.apply(db)
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toContain('idx_thoughts_status_protected_created')
    expect(indexes.map(index => index.name)).toContain('idx_thoughts_status_protected_archived')
    expect(indexes.map(index => index.name)).toContain('idx_thought_importance_importance_hit')
  } finally {
    db.close()
  }
})
