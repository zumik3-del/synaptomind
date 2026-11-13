// The single owner of the baseline schema: `schema-stamp.ts` renders a scratch database from it to
// learn which objects a *pre-baseline* database is allowed to carry, so a second copy would let the
// lost-stamp guard drift away from what `init.ts` actually creates.
export const META_DDL = `CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`

export const BASELINE_TABLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS thoughts (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft',
      source     TEXT,
      project_id TEXT,
      is_cluster INTEGER DEFAULT 0,
      is_profile INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS edges (
      id         TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
      target_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
      type       TEXT NOT NULL DEFAULT 'related',
      created_at TEXT NOT NULL,
      UNIQUE(source_id, target_id, type)
    )`,
  `CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS preview_tokens (
      token       TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    )`
]
