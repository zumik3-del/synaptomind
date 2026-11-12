import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { vec0Path } from '../runtime-mode'
import { isVecExtensionAvailable, seedEmbedding, seedThought, withVecDb } from '../test/helpers'
import { closeDb } from './init'
import { deleteProject } from './projects'
import { updateThought } from './thoughts'

// The ADR 2026-11-12 §7.3 concurrency gate (#2499): v048 makes the server a
// writer of `vec_thoughts` for the first time — four statements inside the
// user's `UPDATE thoughts` — while the embedder child writes the same table from
// another process under WAL. This suite is the two-connection measurement.
//
// Measured on this host (384 dimensions, WAL, `/dev/loop6`), and the numbers the
// assertions below are calibrated against:
//
// - Two `SQLITE_BUSY` outcomes exist on this file, and the move trigger is the
//   cause of neither. A statement that starts the write itself consults
//   `busy_timeout` and fails at the timeout (measured 40.5 ms for 40 ms); a
//   *deferred* transaction that has already read fails the upgrade at once
//   (measured 0.07 ms for the same 40 ms, `updateThought`'s shape since long
//   before v048). With the trigger dropped the move fails identically, because
//   the thought's own `UPDATE` needs the same exclusive write lock the trigger
//   body then runs under: one writer at a time, so the trigger adds no lock
//   acquisition, only statements.
// - The child's side of the same lock is bounded by `busy_timeout` alone: one
//   move holds it ~6.4 ms p50 (WAL commit fsync included), one `insertEmbedding`
//   ~5.4 ms p50, i.e. ~780× headroom against the 5 000 ms production default.
// - The one unbounded window is a bulk move: 0.25 ms/row measured, so the
//   `deleteProject` budget (5 000 ms) is crossed at ~20 000 rows — the caveat
//   recorded in `docs/DEPLOY.md`.

const VEC_AVAILABLE = isVecExtensionAvailable()
/** `config.db.busyTimeout` default, the production value the margins are against. */
const BUSY_TIMEOUT_MS = 5000
/** Short timeout for the case that must observe the wait itself. */
const SHORT_TIMEOUT_MS = 40

/** vec-gated case on a fresh file-backed database that already carries v048. */
function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

afterEach(() => {
  closeDb()
})

/**
 * The second connection on the same file — the embedder child's stand-in.
 * vec0 is loaded because the holder writes `vec_thoughts`, and `busy_timeout` is
 * set per handle so each assertion can state its own budget.
 */
function openWriter(path: string, busyTimeoutMs: number): Database {
  const db = new Database(path)
  db.loadExtension(vec0Path())
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`)
  // The measurement only holds under WAL: rollback-journal mode serializes the two
  // handles differently, so a silent downgrade has to fail loudly.
  const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
  if (mode.journal_mode !== 'wal') throw new Error(`${path} is not in WAL mode`)
  return db
}

/**
 * Take the write lock and keep it while `fn` runs — the state an in-flight
 * writer leaves behind under WAL. The statement is deliberately a no-op delete on
 * `vec_thoughts`, which still begins a write transaction there.
 */
function holdingWriteLock<T>(holder: Database, fn: () => T): T {
  holder.run('BEGIN IMMEDIATE')
  holder.run(`DELETE FROM vec_thoughts WHERE id = 'no-such-row'`)
  try {
    return fn()
  } finally {
    holder.run('ROLLBACK')
  }
}

/** The live trigger DDL, so the reference case can remove and restore it exactly. */
function triggerDdl(db: Database): string {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_thoughts_vec_scope'`
    )
    .get() as { sql: string } | undefined
  if (!row) throw new Error('v048 move trigger missing: the fixture did not run the migration')
  return row.sql
}

function projectOf(db: Database, id: string): string | null {
  const row = db.prepare('SELECT project_id FROM thoughts WHERE id = ?').get(id) as {
    project_id: string | null
  }
  return row.project_id
}

function scopeOf(db: Database, id: string): string | null {
  const row = db.prepare('SELECT scope FROM vec_thoughts WHERE id = ?').get(id) as {
    scope: string
  } | null
  return row?.scope ?? null
}

function stagedRows(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM vec_scope_move').get() as { n: number }).n
}

/** The call's outcome (value or error) with the wall time it took. */
function attempt<T>(fn: () => T): { value: T | null; error: unknown; elapsed: number } {
  const started = performance.now()
  try {
    return { value: fn(), error: null, elapsed: performance.now() - started }
  } catch (error) {
    return { value: null, error, elapsed: performance.now() - started }
  }
}

describe('v048 move trigger under a second writer', () => {
  itVec('a move fails fast, after no busy_timeout wait, while a writer holds the lock', db => {
    const id = seedThought({ content: 'contended thought', project_id: 'proj-a' })
    seedEmbedding(id)
    expect(triggerDdl(db)).toContain('vec_thoughts')

    const holder = openWriter(db.filename, BUSY_TIMEOUT_MS)
    try {
      const { error, elapsed } = holdingWriteLock(holder, () =>
        attempt(() => updateThought(db, id, { project_id: 'proj-b' }))
      )

      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/database is locked/)
      // The upgrade of a deferred transaction that has already read never runs the
      // busy handler, so this lands in well under a millisecond — not at the timeout.
      expect(elapsed).toBeLessThan(BUSY_TIMEOUT_MS / 5)
      // Nothing half-applied: the thought never left its project, its vector is
      // still in the old partition, and no vector is left staged.
      expect(projectOf(db, id)).toBe('proj-a')
      expect(scopeOf(db, id)).toBe('proj-a')
      expect(stagedRows(db)).toBe(0)
    } finally {
      holder.close()
    }
  })

  itVec('the same move fails identically with the move trigger removed', db => {
    // The reference case: the failure is the thought's own UPDATE upgrading its
    // transaction, not the four statements the trigger runs under that lock.
    const id = seedThought({ content: 'contended thought', project_id: 'proj-a' })
    seedEmbedding(id)
    const ddl = triggerDdl(db)
    db.exec('DROP TRIGGER trg_thoughts_vec_scope')

    const holder = openWriter(db.filename, BUSY_TIMEOUT_MS)
    try {
      const { error, elapsed } = holdingWriteLock(holder, () =>
        attempt(() => updateThought(db, id, { project_id: 'proj-b' }))
      )

      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/database is locked/)
      expect(elapsed).toBeLessThan(BUSY_TIMEOUT_MS / 5)
      expect(projectOf(db, id)).toBe('proj-a')
      expect(scopeOf(db, id)).toBe('proj-a')
    } finally {
      holder.close()
    }

    db.exec(ddl)
    expect(triggerDdl(db)).toContain('vec_thoughts')
  })

  itVec('the move lands in the new partition once the other writer releases', db => {
    const id = seedThought({ content: 'retried thought', project_id: 'proj-a' })
    seedEmbedding(id)

    const holder = openWriter(db.filename, BUSY_TIMEOUT_MS)
    try {
      const { error } = holdingWriteLock(holder, () =>
        attempt(() => updateThought(db, id, { project_id: 'proj-b' }))
      )
      expect(error).toBeInstanceOf(Error)
    } finally {
      holder.close()
    }

    // The caller's retry after the `SQLITE_BUSY` is what completes the move; the
    // vector follows in the same transaction as the thought.
    updateThought(db, id, { project_id: 'proj-b' })

    expect(projectOf(db, id)).toBe('proj-b')
    expect(scopeOf(db, id)).toBe('proj-b')
    expect((db.prepare('SELECT COUNT(*) AS n FROM vec_thoughts').get() as { n: number }).n).toBe(1)
    expect(stagedRows(db)).toBe(0)
  })

  itVec('a top-level vector write waits the whole busy_timeout before failing', db => {
    const id = seedThought({ content: 'busy child', project_id: 'proj-a' })
    seedEmbedding(id)

    const holder = openWriter(db.filename, BUSY_TIMEOUT_MS)
    const child = openWriter(db.filename, SHORT_TIMEOUT_MS)
    try {
      const { error, elapsed } = holdingWriteLock(holder, () =>
        // `insertEmbedding`'s VEC-DEL shape: a statement that starts the write
        // itself, so the busy handler is consulted.
        attempt(() => child.run('DELETE FROM vec_thoughts WHERE id = ?', [id]))
      )

      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/database is locked/)
      // Waited rather than failed fast: past half the timeout, far under a second.
      expect(elapsed).toBeGreaterThan(SHORT_TIMEOUT_MS / 2)
      expect(elapsed).toBeLessThan(1000)
      expect(scopeOf(db, id)).toBe('proj-a')

      // The same statement goes through the moment the lock is gone.
      child.run('DELETE FROM vec_thoughts WHERE id = ?', [id])
      expect(scopeOf(db, id)).toBeNull()
    } finally {
      child.close()
      holder.close()
    }
  })

  itVec('a bulk move stays inside the child busy_timeout budget', db => {
    // Functional coverage of the bulk path lives beside this suite (#2501); the
    // assertion here is the measured lock window, because `deleteProject` is the
    // only move that can hold the write lock long enough for the child to fail.
    const rows = 100
    const bulk = 'proj-bulk'
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run(
      bulk,
      bulk,
      '2020-01-01T00:00:00.000Z'
    )
    const seeded: string[] = []
    db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const id = seedThought({ content: `bulk ${i}`, project_id: bulk })
        seedEmbedding(id)
        seeded.push(id)
      }
    })()
    const target = (
      db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as {
        value: string
      }
    ).value

    const { value, error, elapsed } = attempt(() => deleteProject(db, bulk))

    expect(error).toBeNull()
    expect(value).toBe(true)
    expect(scopeOf(db, seeded[0]!)).toBe(target)
    expect(scopeOf(db, seeded[rows - 1]!)).toBe(target)
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM vec_thoughts WHERE scope = ?`).get(bulk) as {
          n: number
        }
      ).n
    ).toBe(0)
    expect(stagedRows(db)).toBe(0)
    // 0.25 ms/row measured on this host: ~25 ms for 100 rows, so both bounds leave
    // more than an order of magnitude — they catch a per-row cost that turned
    // quadratic, not jitter.
    expect(elapsed).toBeLessThan(BUSY_TIMEOUT_MS)
    expect(elapsed / rows).toBeLessThan(5)
  })
})
