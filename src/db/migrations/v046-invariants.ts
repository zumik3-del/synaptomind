import type { Database } from 'bun:sqlite'
import { computeContentHash } from '../../utils'

/**
 * v046 — graph invariants that used to live only in application code:
 * one edge per unordered pair, and one live (draft/active) thought per
 * (content_hash, project_id).
 *
 * Both repairs run before the unique indexes are created, so a legacy database
 * that already contains violations still migrates instead of failing. The
 * guards (`tableExists`/`columnExists`) that older migrations needed are gone:
 * by v45 the bootstrap has created `thoughts`/`edges` and v033/v036/v037 added
 * every column used here.
 */
export default {
  version: 46,
  apply(db: Database): void {
    const now = new Date().toISOString()

    // --- Data repair: edge duplicates (one edge per canonical pair) ---

    // A self-loop cannot satisfy "one edge between two distinct thoughts" and
    // no edge type means anything on one, so these rows are dropped rather than
    // archived: unlike thoughts, an edge carries no knowledge of its own and
    // `findSelfLoopEdges` reports any that reappear.
    db.run(`DELETE FROM edges WHERE source_id = target_id`)

    // Keep exactly one edge per unordered pair: a specific relation beats the
    // generic 'related', then the lowest id wins. The same ROW_NUMBER technique
    // as the thought dedupe below, so both repairs read the same way.
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

    // --- Data repair: content-hash backfill + duplicate draft/active thoughts ---

    // Same hash as the write path (`computeContentHash`), so the backfill and
    // the runtime key can never drift. A NULL project_id has no runtime
    // equivalent (the write path always resolves a project) and hashes as ''.
    const rows = db.prepare(`SELECT id, content, project_id FROM thoughts WHERE content_hash IS NULL`).all() as Array<{
      id: string
      content: string
      project_id: string | null
    }>
    const update = db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`)
    for (const row of rows) {
      update.run(computeContentHash(row.content, row.project_id ?? ''), row.id)
    }

    // Archive duplicate live thoughts sharing (content_hash, project_id),
    // keeping the oldest (created_at, id).
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

    // --- Indexes ---

    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON edges (min(source_id, target_id), max(source_id, target_id))`)
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_content_dedupe ON thoughts (content_hash, project_id) WHERE status IN ('draft', 'active')`
    )

    // --- Data-repair check: no remaining duplicates ---
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
