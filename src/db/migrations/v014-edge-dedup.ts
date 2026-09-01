import type { Database } from 'bun:sqlite'

export default {
  version: 14,
  apply(db: Database): void {
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
}
