import type { Database } from 'bun:sqlite'

export type EntityType = 'code' | 'tag' | 'wiki' | 'term'

export interface ThoughtEntity {
  thought_id: string
  entity_name: string
  entity_type: EntityType
  created_at: string
}

export interface EntityInfo {
  name: string
  type: EntityType
  thought_count: number
}

export function getEntitiesForThought(db: Database, thoughtId: string): ThoughtEntity[] {
  return db
    .prepare(`SELECT * FROM thought_entities WHERE thought_id = ? ORDER BY entity_name`)
    .all(thoughtId) as ThoughtEntity[]
}

export function searchEntities(db: Database, query: string, limit = 20): EntityInfo[] {
  const pattern = `%${query.toLowerCase().replace(/[%_]/g, c => `\\${c}`)}%`
  return db
    .prepare(`
    SELECT entity_name as name, entity_type as type, COUNT(DISTINCT thought_id) as thought_count
    FROM thought_entities
    WHERE LOWER(entity_name) LIKE ? ESCAPE '\\'
    GROUP BY entity_name, entity_type
    ORDER BY thought_count DESC
    LIMIT ?
  `)
    .all(pattern, limit) as EntityInfo[]
}

export function getThoughtIdsByEntity(db: Database, entityName: string): string[] {
  const rows = db
    .prepare(`SELECT thought_id FROM thought_entities WHERE entity_name = ?`)
    .all(entityName) as { thought_id: string }[]
  return rows.map(r => r.thought_id)
}

export function deleteEntitiesForThought(db: Database, thoughtId: string): void {
  db.prepare(`DELETE FROM thought_entities WHERE thought_id = ?`).run(thoughtId)
}

export function upsertEntities(
  db: Database,
  thoughtId: string,
  entities: Array<{ name: string; type: EntityType }>
): void {
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT OR IGNORE INTO thought_entities (thought_id, entity_name, entity_type, created_at)
     VALUES (?, ?, ?, ?)`
  )
  const tx = db.transaction(() => {
    deleteEntitiesForThought(db, thoughtId)
    for (const e of entities) {
      ins.run(thoughtId, e.name, e.type, now)
    }
  })
  tx()
}
