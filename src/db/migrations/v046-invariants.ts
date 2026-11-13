import type { Database } from 'bun:sqlite'
import { computeContentHash } from '../../utils'

export default {
  version: 46,
  apply(db: Database): void {
    const now = new Date().toISOString()

    db.run(`DELETE FROM edges WHERE source_id = target_id`)

    db.run(`
      DELETE FROM edges
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY min(source_id, target_id), max(source_id, target_id)
            ORDER BY (type = 'related') ASC, id ASC
          ) AS rn
          FROM edges
        ) WHERE rn = 1
      )
    `)

    const rows = db
      .prepare(`SELECT id, content, project_id FROM thoughts WHERE content_hash IS NULL`)
      .all() as Array<{
      id: string
      content: string
      project_id: string | null
    }>
    const update = db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`)
    for (const row of rows) {
      update.run(computeContentHash(row.content, row.project_id ?? ''), row.id)
    }

    db.prepare(`
      UPDATE thoughts
      SET status = 'archived', archived_at = ?, updated_at = ?, is_protected = 0
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY content_hash, project_id
              ORDER BY created_at ASC, id ASC
            ) AS rn
          FROM thoughts
          WHERE status IN ('draft', 'active') AND content_hash IS NOT NULL
        ) WHERE rn > 1
      )
    `).run(now, now)

    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON edges (min(source_id, target_id), max(source_id, target_id))`
    )
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_content_dedupe ON thoughts (content_hash, project_id) WHERE status IN ('draft', 'active')`
    )

    const dupEdges = db
      .prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT min(source_id, target_id) a, max(source_id, target_id) b
          FROM edges GROUP BY a, b HAVING COUNT(*) > 1
        )
      `)
      .get() as { c: number }
    if (dupEdges.c > 0) throw new Error('data repair failed: duplicate edge pairs remain')

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
