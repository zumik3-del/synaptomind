import type { Database } from 'bun:sqlite'

export default {
  version: 34,
  apply(db: Database): void {
    db.run(`DROP TABLE IF EXISTS git_commits`)
    db.run(`DROP TABLE IF EXISTS pending_git_embeddings`)
    db.run(`DROP TABLE IF EXISTS vec_git_commits`)

    // Remove git columns from projects using legacy alter pattern
    db.run(`CREATE TABLE IF NOT EXISTS _projects_new (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL,
      local_path  TEXT
    )`)
    db.run(`
      INSERT INTO _projects_new (id, name, description, created_at, local_path)
      SELECT id, name, description, created_at, local_path FROM projects
    `)
    db.run(`DROP TABLE projects`)
    db.run(`ALTER TABLE _projects_new RENAME TO projects`)
  }
}
