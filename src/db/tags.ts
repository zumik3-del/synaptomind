import type { Database } from 'bun:sqlite'
import { sqlIn } from './utils'

export interface Tag {
  id: string
  name: string
}

function canonicalTagName(name: string): string {
  return name.startsWith('@') ? name.toLowerCase() : name
}

export function findTagByName(db: Database, name: string): Tag | undefined {
  const row = db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name) as Tag | null
  return row ?? undefined
}

export function createTag(db: Database, name: string): Tag {
  const canonical = canonicalTagName(name)
  const existing = findTagByName(db, canonical)
  if (existing) return existing
  const id = Bun.randomUUIDv7()
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(id, canonical, new Date().toISOString())
  return { id, name: canonical }
}

export function mergeThoughtTags(db: Database, thoughtId: string, tagNames: string[]): Tag[] {
  const existing = getThoughtTags(db, thoughtId).map(t => t.name)
  return setThoughtTags(db, thoughtId, [...existing, ...tagNames])
}

export function setThoughtTags(db: Database, thoughtId: string, tagNames: string[]): Tag[] {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM thought_tags WHERE thought_id = ?').run(thoughtId)

    const tags: Tag[] = []
    for (const name of tagNames) {
      const tag = createTag(db, name)
      db.prepare('INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(thoughtId, tag.id)
      tags.push(tag)
    }

    pruneOrphanTags(db)

    return tags
  })

  return run()
}

export function getThoughtTags(db: Database, thoughtId: string): Tag[] {
  return db
    .prepare(`
    SELECT t.id, t.name
    FROM tags t
    INNER JOIN thought_tags tt ON tt.tag_id = t.id
    WHERE tt.thought_id = ?
    ORDER BY t.name COLLATE NOCASE
  `)
    .all(thoughtId) as Tag[]
}

export function getThoughtTagsBatch(db: Database, thoughtIds: string[]): Map<string, Tag[]> {
  if (thoughtIds.length === 0) return new Map()
  const ph = sqlIn(thoughtIds)
  const rows = db
    .prepare(`
    SELECT tt.thought_id, t.id, t.name
    FROM tags t
    INNER JOIN thought_tags tt ON tt.tag_id = t.id
    WHERE tt.thought_id IN (${ph})
    ORDER BY t.name COLLATE NOCASE
  `)
    .all(...thoughtIds) as Array<{ thought_id: string } & Tag>

  const map = new Map<string, Tag[]>()
  for (const id of thoughtIds) map.set(id, [])
  for (const r of rows) {
    map.get(r.thought_id)?.push({ id: r.id, name: r.name })
  }
  return map
}

export function pruneOrphanTags(db: Database): void {
  db.prepare(`
    DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM thought_tags)
  `).run()
}
