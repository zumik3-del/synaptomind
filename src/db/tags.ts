import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'
import { sqlIn } from './utils'

export interface Tag {
  id: string
  name: string
}

export interface TagWithCount extends Tag {
  thought_count: number
}

export function listTags(db: Database, q?: string): TagWithCount[] {
  const where = q ? `WHERE LOWER(t.name) LIKE ? ESCAPE '\\'` : ''
  const param = q ? [`%${q.toLowerCase().replace(/[%_]/g, c => `\\${c}`)}%`] : []
  return db
    .prepare(`
    SELECT t.id, t.name, COUNT(tt.thought_id) as thought_count
    FROM tags t
    LEFT JOIN thought_tags tt ON tt.tag_id = t.id
    ${where}
    GROUP BY t.id, t.name
    ORDER BY t.name COLLATE NOCASE
  `)
    .all(...param) as TagWithCount[]
}

export function findTagByName(db: Database, name: string): Tag | undefined {
  const row = db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name) as Tag | null
  return row ?? undefined
}

export function createTag(db: Database, name: string): Tag {
  const canonical = name.startsWith('@') ? name.toLowerCase() : name
  const existing = findTagByName(db, canonical)
  if (existing) return existing
  const id = uuidv7()
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(id, canonical, new Date().toISOString())
  return { id, name: canonical }
}

export function renameTag(db: Database, id: string, newName: string): Tag | undefined {
  const existing = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id) as Tag | undefined
  if (!existing) return undefined
  const canonical = newName.startsWith('@') ? newName.toLowerCase() : newName
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(canonical, id)
  return { id, name: canonical }
}

export function deleteTag(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  return result.changes > 0
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
