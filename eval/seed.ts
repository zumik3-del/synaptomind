import type { Database } from 'bun:sqlite'
import type { EvalScenario } from './types'
import type { EmbedFn } from './search'

/**
 * Seeds one scenario into a freshly-initialised file-backed DB.
 *
 * Embeddings are supplied by the caller so the harness can run either the
 * deterministic embedder (default) or the real one (`--real`). The FTS and
 * importance triggers installed by migrations fire on INSERT, so only thoughts,
 * edges and vec rows are written explicitly.
 */
export async function seedScenario(
  db: Database,
  scenario: EvalScenario,
  embed: EmbedFn
): Promise<void> {
  const now = new Date().toISOString()

  for (const thought of scenario.thoughts) {
    const projectId = thought.projectId ?? 'default'
    db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
      projectId,
      projectId,
      now
    )
    db.prepare(`
      INSERT INTO thoughts
        (id, content, status, source, project_id, is_cluster, is_profile, is_protected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thought.id,
      thought.content,
      thought.status ?? 'active',
      'eval',
      projectId,
      thought.isCluster ? 1 : 0,
      0,
      1,
      thought.createdAt ?? now,
      now
    )

    if (thought.importance !== undefined) {
      db.prepare('UPDATE thought_importance SET importance = ? WHERE thought_id = ?').run(
        thought.importance,
        thought.id
      )
    }

    const vector = await embed(thought.content)
    db.prepare('INSERT OR REPLACE INTO vec_thoughts (id, embedding) VALUES (?, ?)').run(
      thought.id,
      Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
    )
  }

  for (const edge of scenario.edges ?? []) {
    db.prepare(`
      INSERT OR IGNORE INTO edges (id, source_id, target_id, type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), edge.source, edge.target, edge.type ?? 'related', now)
  }
}
