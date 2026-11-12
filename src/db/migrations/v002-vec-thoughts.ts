import type { Database } from 'bun:sqlite'
import { vecTableDdl } from '../vec-schema'

export default {
  version: 2,
  apply(db: Database, opts: { isMemory: boolean; dimensions: number }): void {
    db.run(`DROP TABLE IF EXISTS vec_thoughts`)
    try {
      db.run(vecTableDdl(opts.dimensions))
    } catch {
      if (opts.isMemory) return
      throw new Error('vec0 extension required for vec_thoughts')
    }
  }
}
