import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'
import { sqlIn } from './utils'

export interface ThoughtUrlLink {
  id: string
  thought_id: string
  key: string
  url: string
  label: string
  sort_order: number
  created_at: string
}

export function upsertThoughtUrlLink(
  db: Database,
  thoughtId: string,
  key: string,
  url: string,
  label: string,
  sortOrder = 0
): ThoughtUrlLink {
  const existing = db
    .prepare('SELECT id FROM thought_url_links WHERE thought_id = ? AND key = ?')
    .get(thoughtId, key) as { id: string } | undefined
  const now = new Date().toISOString()
  if (existing) {
    db.prepare('UPDATE thought_url_links SET url = ?, label = ?, sort_order = ?, created_at = ? WHERE id = ?').run(
      url,
      label,
      sortOrder,
      now,
      existing.id
    )
    return db.prepare('SELECT * FROM thought_url_links WHERE id = ?').get(existing.id) as ThoughtUrlLink
  }
  const id = uuidv7()
  db.prepare(
    'INSERT INTO thought_url_links (id, thought_id, key, url, label, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, thoughtId, key, url, label, sortOrder, now)
  return db.prepare('SELECT * FROM thought_url_links WHERE id = ?').get(id) as ThoughtUrlLink
}

export function getThoughtUrlLinks(db: Database, thoughtId: string): ThoughtUrlLink[] {
  return db
    .prepare('SELECT * FROM thought_url_links WHERE thought_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(thoughtId) as ThoughtUrlLink[]
}

export function getThoughtUrlLinksForThoughts(db: Database, thoughtIds: string[]): ThoughtUrlLink[] {
  if (thoughtIds.length === 0) return []
  const ph = sqlIn(thoughtIds)
  return db
    .prepare(
      `SELECT * FROM thought_url_links WHERE thought_id IN (${ph})
       ORDER BY sort_order ASC, created_at ASC`
    )
    .all(...thoughtIds) as ThoughtUrlLink[]
}

export function deleteThoughtUrlLink(db: Database, thoughtId: string, key: string): boolean {
  const result = db.prepare('DELETE FROM thought_url_links WHERE thought_id = ? AND key = ?').run(thoughtId, key)
  return result.changes > 0
}

export function pruneThoughtUrlLinks(db: Database, thoughtId: string, content: string): number {
  return deleteThoughtUrlLinksNotIn(db, thoughtId, extractLinkKeys(content))
}

export function deleteThoughtUrlLinksNotIn(db: Database, thoughtId: string, keys: string[]): number {
  if (keys.length === 0) {
    return db.prepare('DELETE FROM thought_url_links WHERE thought_id = ?').run(thoughtId).changes
  }
  const ph = sqlIn(keys)
  return db
    .prepare(`DELETE FROM thought_url_links WHERE thought_id = ? AND key NOT IN (${ph})`)
    .run(thoughtId, ...keys).changes
}

export function extractLinkKeys(content: string): string[] {
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  const keys: string[] = []
  let m: RegExpExecArray | null = re.exec(content)
  while (m !== null) {
    const k = m[1].trim()
    if (k) keys.push(k)
    m = re.exec(content)
  }
  return keys
}
