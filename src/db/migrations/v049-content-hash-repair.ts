import type { Database } from 'bun:sqlite'
import { computeContentHash } from '../../utils'

interface ThoughtRow {
  id: string
  content: string
  project_id: string | null
  content_hash: string | null
}

export default {
  version: 49,
  apply(db: Database): void {
    const now = new Date().toISOString()

    // Archived first: the recompute below converges colliding rows onto one hash, which
    // idx_thoughts_content_dedupe would reject before the repair is complete.
    db.prepare(`
      UPDATE thoughts
      SET status = 'archived', archived_at = ?, updated_at = ?, is_protected = 0
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY content, project_id
              ORDER BY created_at ASC, id ASC
            ) AS rn
          FROM thoughts
          WHERE status IN ('draft', 'active')
        ) WHERE rn > 1
      )
    `).run(now, now)

    const rows = db
      .prepare(`SELECT id, content, project_id, content_hash FROM thoughts`)
      .all() as ThoughtRow[]
    const update = db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`)
    for (const row of rows) {
      const hash = computeContentHash(row.content, row.project_id ?? '')
      if (hash !== row.content_hash) update.run(hash, row.id)
    }

    const duplicates = db
      .prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT content_hash, project_id
          FROM thoughts WHERE status IN ('draft', 'active') AND content_hash IS NOT NULL
          GROUP BY content_hash, project_id HAVING COUNT(*) > 1
        )
      `)
      .get() as { c: number }
    if (duplicates.c > 0) throw new Error('v049 repair failed: duplicate live content remains')
  }
}
