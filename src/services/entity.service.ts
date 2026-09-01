import { getDb } from '../db'
import { getEntitiesForThought as dbGetEntitiesForThought, searchEntities as dbSearchEntities, upsertEntities } from '../db/thought_entities'
import { extractEntities } from './entity-extract'

export type { EntityType } from './entity-extract'
export { extractEntities } from './entity-extract'

export interface ThoughtEntity {
  thought_id: string
  entity_name: string
  entity_type: import('./entity-extract').EntityType
  created_at: string
}

export interface EntityInfo {
  name: string
  type: import('./entity-extract').EntityType
  thought_count: number
}

export function syncEntities(thoughtId: string, content: string): void {
  const d = getDb()
  const entities = extractEntities(content)
  upsertEntities(d, thoughtId, entities)
}

export function entitySearchIds(query: string, limit: number): string[] {
  const d = getDb()
  const tokens = query
    .split(/\s+/)
    .map(t => t.trim().replace(/^#+/, '').toLowerCase())
    .filter(t => t.length >= 2)
  if (tokens.length === 0) return []
  const conditions = tokens.map(() => `entity_name LIKE ? ESCAPE '\\'`)
  const params: (string | number)[] = tokens.map(t => `%${t.replace(/[%_]/g, c => `\\${c}`)}%`)
  const safeLimit = Math.max(1, Math.floor(limit))
  const sql = `SELECT thought_id, COUNT(*) as match_count
       FROM thought_entities
       WHERE ${conditions.join(' OR ')}
       GROUP BY thought_id
       ORDER BY match_count DESC
       LIMIT ?`
  const rows = d.prepare(sql).all(...params, safeLimit) as Array<{ thought_id: string; match_count: number }>
  return rows.map(r => r.thought_id)
}

export function listEntities(options: { type?: import('./entity-extract').EntityType; limit?: number } = {}): EntityInfo[] {
  return dbSearchEntities(getDb(), options.type ?? '', options.limit ?? 100)
}

export function getEntitiesForThought(thoughtId: string): ThoughtEntity[] {
  return dbGetEntitiesForThought(getDb(), thoughtId)
}
