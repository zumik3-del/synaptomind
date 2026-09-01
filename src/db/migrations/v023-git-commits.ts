import type { Database } from 'bun:sqlite'

export default {
  version: 23,
  apply(db: Database, opts: { isMemory: boolean; dimensions: number }): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS git_commits (
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_git_commits_committed ON git_commits(committed_at)`)
    db.run(`
      CREATE TABLE IF NOT EXISTS pending_git_embeddings (
        commit_id  TEXT PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        attempts   INTEGER DEFAULT 0,
        last_error TEXT,
        is_error   INTEGER DEFAULT 0,
        error      TEXT
      )
    `)
    try {
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_git_commits USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[${opts.dimensions}] distance_metric=cosine
      )`)
    } catch {
      // vec0 unavailable in :memory: tests
    }
  }
}
