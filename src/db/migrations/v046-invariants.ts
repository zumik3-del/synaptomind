import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { 1: number } | undefined
  return !!row
}

function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

export default {
  version: 46,
  apply(db: Database): void {
    const now = new Date().toISOString()

    // --- Data repair: edge duplicates (one edge per canonical pair) ---
    if (tableExists(db, 'edges')) {
      db.run(`DELETE FROM edges WHERE source_id = target_id`)
      db.run(`
        DELETE FROM edges
        WHERE id IN (
          SELECT e.id FROM edges e
          JOIN (
            SELECT min(source_id, target_id) a, max(source_id, target_id) b, COUNT(*) c
            FROM edges
            GROUP BY a, b
            HAVING c > 1
          ) g ON (e.source_id = g.a AND e.target_id = g.b) OR (e.source_id = g.b AND e.target_id = g.a)
          WHERE e.id NOT IN (
            SELECT (
              SELECT id FROM edges
              WHERE (source_id = g2.a AND target_id = g2.b) OR (source_id = g2.b AND target_id = g2.a)
              ORDER BY (type = 'related') ASC, id ASC
              LIMIT 1
            ) FROM (
              SELECT min(source_id, target_id) a, max(source_id, target_id) b, COUNT(*) c
              FROM edges
              GROUP BY a, b
              HAVING c > 1
            ) g2
          )
        )
      `)
    }

    // --- Data repair: content-hash backfill + duplicate draft/active thoughts ---
    if (tableExists(db, 'thoughts')) {
      if (columnExists(db, 'thoughts', 'content_hash') && columnExists(db, 'thoughts', 'content') && columnExists(db, 'thoughts', 'project_id')) {
        const rows = db
          .prepare(`SELECT id, content, project_id FROM thoughts WHERE content_hash IS NULL`)
          .all() as Array<{ id: string; content: string; project_id: string | null }>
        const update = db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`)
        for (const row of rows) {
          const hash = createHash('sha256').update(row.content + (row.project_id ?? '')).digest('hex')
          update.run(hash, row.id)
        }
      }

      // Archive duplicate draft/active thoughts sharing (content_hash, project_id),
      // keeping the oldest (created_at, id).
      if (columnExists(db, 'thoughts', 'content_hash') && columnExists(db, 'thoughts', 'status')) {
        const hasArchivedAt = columnExists(db, 'thoughts', 'archived_at')
        const hasUpdated = columnExists(db, 'thoughts', 'updated_at')
        const hasProtected = columnExists(db, 'thoughts', 'is_protected')
        const setClauses = ["status = 'archived'"]
        if (hasArchivedAt) setClauses.push('archived_at = ?')
        if (hasUpdated) setClauses.push('updated_at = ?')
        if (hasProtected) setClauses.push('is_protected = 0')

        const orderBy = columnExists(db, 'thoughts', 'created_at') ? 'created_at ASC, id ASC' : 'id ASC'
        const partition = 'content_hash, project_id'
        const sql = `
          UPDATE thoughts
          SET ${setClauses.join(', ')}
          WHERE id IN (
            SELECT id FROM (
              SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY ${partition}
                  ORDER BY ${orderBy}
                ) AS rn
              FROM thoughts
              WHERE status IN ('draft', 'active') AND content_hash IS NOT NULL
            ) WHERE rn > 1
          )
        `
        if (hasArchivedAt && hasUpdated) {
          db.prepare(sql).run(now, now)
        } else if (hasArchivedAt) {
          db.prepare(sql).run(now)
        } else if (hasUpdated) {
          db.prepare(sql).run(now)
        } else {
          db.run(sql)
        }
      }
    }

    // --- Indexes ---
    if (tableExists(db, 'edges')) {
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON edges (min(source_id, target_id), max(source_id, target_id))`)
    }
    if (tableExists(db, 'thoughts')) {
      if (columnExists(db, 'thoughts', 'content_hash') && columnExists(db, 'thoughts', 'project_id') && columnExists(db, 'thoughts', 'status')) {
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_content_dedupe ON thoughts (content_hash, project_id) WHERE status IN ('draft', 'active')`)
      }
    }

    // --- Data-repair check: no remaining duplicates ---
    if (tableExists(db, 'edges')) {
      const dupEdges = db
        .prepare(`
          SELECT COUNT(*) AS c FROM (
            SELECT min(source_id, target_id) a, max(source_id, target_id) b
            FROM edges GROUP BY a, b HAVING COUNT(*) > 1
          )
        `)
        .get() as { c: number }
      if (dupEdges.c > 0) throw new Error('data repair failed: duplicate edge pairs remain')
    }
    if (tableExists(db, 'thoughts') && columnExists(db, 'thoughts', 'content_hash')) {
      const dupThoughts = db
        .prepare(`
          SELECT COUNT(*) AS c FROM (
            SELECT content_hash, project_id
            FROM thoughts WHERE status IN ('draft', 'active') AND content_hash IS NOT NULL
            GROUP BY content_hash, project_id HAVING COUNT(*) > 1
          )
        `)
        .get() as { c: number }
      if (dupThoughts.c > 0) throw new Error('data repair failed: duplicate content hashes remain')
    }
  }
}
