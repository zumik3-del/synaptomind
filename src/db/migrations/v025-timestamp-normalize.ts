import type { Database } from 'bun:sqlite'

export default {
  version: 25,
  apply(db: Database): void {
    const iso = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${col})`
    const spaceFormat = (col: string) => `${col} LIKE '____-__-__ __%'`
    const updates: Array<[string, string[]]> = [
      ['thoughts', ['created_at', 'updated_at']],
      ['edges', ['created_at']],
      ['projects', ['created_at']],
      ['tags', ['created_at']],
      ['pending_embeddings', ['created_at']],
      ['pending_git_embeddings', ['created_at']],
      ['thought_importance', ['last_decay', 'created_at']],
      ['primers', ['promoted_at', 'created_at']],
      ['thought_verify', ['last_checked', 'created_at']],
      ['smart_notes', ['surface_checked_at', 'created_at']],
      ['slots', ['updated_at']],
      ['git_commits', ['created_at']]
    ]
    for (const [table, cols] of updates) {
      for (const col of cols) {
        db.run(`UPDATE ${table} SET ${col} = ${iso(col)} WHERE ${spaceFormat(col)}`)
      }
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, type)`)
  }
}
