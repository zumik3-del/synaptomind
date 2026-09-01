import type { Database } from 'bun:sqlite'

export default {
  version: 27,
  apply(db: Database): void {
    for (const col of [
      'is_git_linked INTEGER DEFAULT 0',
      'git_repo_url TEXT',
      'git_auto_sync INTEGER DEFAULT 0',
      'git_sync_interval_ms INTEGER'
    ]) {
      try {
        db.run(`ALTER TABLE projects ADD COLUMN ${col}`)
      } catch {
        // column already exists
      }
    }

    const legacyRepo = ''
    db.run('PRAGMA legacy_alter_table = ON')
    db.run(`
      CREATE TABLE git_commits_new (
        id           TEXT PRIMARY KEY,
        repo         TEXT NOT NULL DEFAULT '',
        project_id   TEXT,
        hash         TEXT NOT NULL,
        message      TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        author       TEXT,
        created_at   TEXT NOT NULL,
        UNIQUE(repo, hash)
      )
    `)
    db.run(
      `INSERT OR IGNORE INTO git_commits_new (id, repo, project_id, hash, message, committed_at, author, created_at)
       SELECT id, ?, NULL, hash, message, committed_at, author, created_at FROM git_commits`,
      [legacyRepo]
    )
    db.run(`DROP TABLE git_commits`)
    db.run(`ALTER TABLE git_commits_new RENAME TO git_commits`)
    db.run('PRAGMA legacy_alter_table = OFF')
  }
}
