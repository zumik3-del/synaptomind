import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

export default {
  version: 33,
  apply(db: Database): void {
    try {
      db.run(`ALTER TABLE thoughts ADD COLUMN content_hash TEXT`)
    } catch {
      // column already exists
    }

    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_content_hash ON thoughts(content_hash)`)

    const rows = db.prepare(`SELECT id, content, project_id FROM thoughts WHERE content_hash IS NULL`).all() as {
      id: string
      content: string
      project_id: string
    }[]

    const update = db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`)
    for (const row of rows) {
      const hash = createHash('sha256').update(row.content + row.project_id).digest('hex')
      update.run(hash, row.id)
    }
  }
}
