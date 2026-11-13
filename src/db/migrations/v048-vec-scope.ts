import type { Database } from 'bun:sqlite'
import { statfsSync } from 'node:fs'
import { scopeSql, vecTableDdl } from '../vec-schema'

const STAGE_TABLE = 'vec_thoughts_scope_stage'
const STAGE_INDEX = 'idx_vec_thoughts_scope_stage_scope'
const MOVE_TABLE = 'vec_scope_move'
const MOVE_TRIGGER = 'trg_thoughts_vec_scope'
const MARKER_KEY = 'vec_scope_v048'

function writeMarker(db: Database, value: 'stage' | 'done'): void {
  db.prepare(
    `INSERT INTO _meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(MARKER_KEY, value)
}

function requireFreeSpace(db: Database, vectorBytes: number, rows: number): void {
  const stagedBytes = vectorBytes + rows * 128
  const filename = db.filename
  if (!filename || filename === ':memory:' || stagedBytes === 0) return
  const stats = statfsSync(filename)
  const freeBytes = Number(stats.bavail) * Number(stats.bsize)
  if (freeBytes >= 2 * stagedBytes) return
  const mb = (bytes: number) => Math.ceil(bytes / (1024 * 1024))
  throw new Error(
    `v048 cannot rebuild vec_thoughts: it needs about ${mb(2 * stagedBytes)} MB free ` +
      `(2 × ${mb(stagedBytes)} MB of staged vectors) but only ${mb(freeBytes)} MB is available ` +
      `at ${filename}. Free disk space and restart; the migration has not been applied.`
  )
}

function moveTriggerSql(): string {
  return `CREATE TRIGGER ${MOVE_TRIGGER} AFTER UPDATE OF project_id, is_global ON thoughts
WHEN OLD.is_global IS NOT NEW.is_global OR OLD.project_id IS NOT NEW.project_id
BEGIN
  INSERT INTO ${MOVE_TABLE} (id, embedding)
    SELECT id, embedding FROM vec_thoughts WHERE id = NEW.id;
  DELETE FROM vec_thoughts WHERE id = NEW.id;
  INSERT INTO vec_thoughts (id, embedding, scope)
    SELECT id, embedding, ${scopeSql('NEW')}
    FROM ${MOVE_TABLE} WHERE id = NEW.id;
  DELETE FROM ${MOVE_TABLE} WHERE id = NEW.id;
END`
}

export default {
  version: 48,
  apply(db: Database, opts: { isMemory: boolean; dimensions: number }): void {
    if (opts.isMemory) return

    db.exec(`DROP TRIGGER IF EXISTS ${MOVE_TRIGGER}`)
    db.exec(`DROP TABLE IF EXISTS ${STAGE_TABLE}`)

    const vecTableExists = Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_thoughts'`).get()
    )
    const stats = vecTableExists
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(length(embedding)), 0) AS bytes, COUNT(*) AS rows FROM vec_thoughts`
          )
          .get() as { bytes: number; rows: number })
      : { bytes: 0, rows: 0 }
    requireFreeSpace(db, stats.bytes, stats.rows)

    db.exec(
      `CREATE TABLE ${STAGE_TABLE} (id TEXT PRIMARY KEY, embedding BLOB NOT NULL, scope TEXT NOT NULL)`
    )
    db.exec(`CREATE INDEX ${STAGE_INDEX} ON ${STAGE_TABLE} (scope)`)
    if (vecTableExists) {
      db.exec(`
        INSERT INTO ${STAGE_TABLE} (id, embedding, scope)
        SELECT v.id, v.embedding, ${scopeSql('t')}
        FROM vec_thoughts v
        JOIN thoughts t ON t.id = v.id
      `)
    }
    const staged = db.prepare(`SELECT COUNT(*) AS n FROM ${STAGE_TABLE}`).get() as { n: number }
    writeMarker(db, 'stage')

    db.exec(`DROP TABLE IF EXISTS vec_thoughts`)
    db.run(vecTableDdl(opts.dimensions, false))
    db.exec(`
      INSERT INTO vec_thoughts (id, embedding, scope)
      SELECT id, embedding, scope FROM ${STAGE_TABLE} ORDER BY scope
    `)
    db.exec(`DROP TABLE IF EXISTS ${STAGE_TABLE}`)

    db.exec(
      `CREATE TABLE IF NOT EXISTS ${MOVE_TABLE} (id TEXT PRIMARY KEY, embedding BLOB NOT NULL)`
    )
    db.exec(moveTriggerSql())
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_thoughts_is_global ON thoughts (is_global) WHERE is_global = 1`
    )

    const copied = db.prepare(`SELECT COUNT(*) AS n FROM vec_thoughts`).get() as { n: number }
    if (copied.n !== staged.n) {
      throw new Error(
        `v048 verify failed: staged ${staged.n} vectors but copied ${copied.n} into vec_thoughts`
      )
    }
    const mismatched = db
      .prepare(`
        SELECT COUNT(*) AS n
        FROM vec_thoughts v
        JOIN thoughts t ON t.id = v.id
        WHERE v.scope <> ${scopeSql('t')}
      `)
      .get() as { n: number }
    if (mismatched.n > 0) {
      throw new Error(
        `v048 verify failed: ${mismatched.n} vectors disagree with their thought's scope`
      )
    }
    const duplicated = db
      .prepare(`SELECT COUNT(*) - COUNT(DISTINCT id) AS n FROM vec_thoughts`)
      .get() as { n: number }
    if (duplicated.n > 0) {
      throw new Error(`v048 verify failed: ${duplicated.n} duplicate vector ids remain`)
    }

    writeMarker(db, 'done')
  }
}
