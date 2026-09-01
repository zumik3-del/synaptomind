import type { Database } from 'bun:sqlite'

export default {
  version: 2,
  apply(db: Database, opts: { isMemory: boolean; dimensions: number }): void {
    db.run(`DROP TABLE IF EXISTS vec_thoughts`)
    try {
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_thoughts USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[${opts.dimensions}] distance_metric=cosine
      )`)
    } catch {
      if (opts.isMemory) return
      throw new Error('vec0 extension required for vec_thoughts')
    }
  }
}
