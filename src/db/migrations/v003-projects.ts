import type { Database } from 'bun:sqlite'

export default {
  version: 3,
  apply(db: Database): void {
    const metaRow = db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
      | { value: string }
      | undefined
    const defaultProjectId = metaRow?.value ?? crypto.randomUUID()

    if (!metaRow) {
      db.prepare(`INSERT INTO _meta (key, value) VALUES ('default_project_id', ?)`).run(defaultProjectId)
    }
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(
      defaultProjectId,
      new Date().toISOString()
    )

    try {
      db.run(`ALTER TABLE thoughts ADD COLUMN project_id TEXT`)
    } catch {
      // column already exists
    }
    db.prepare(`UPDATE thoughts SET project_id = ? WHERE project_id IS NULL`).run(defaultProjectId)
  }
}
