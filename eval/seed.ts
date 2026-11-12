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
 *
 * Vectors are computed first and the writes then run inside one transaction: a
 * per-row commit costs ~10 ms here (a 900-row probe took 9 s that way, 0.15 s
 * batched), and the seeded rows are identical either way.
 */
export async function seedScenario(
  db: Database,
  scenario: EvalScenario,
  embed: EmbedFn
): Promise<void> {
  const now = new Date().toISOString()
  const vectors: Float32Array[] = []
  for (const thought of scenario.thoughts) vectors.push(await embed(thought.content))

  const insertProject = db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)'
  )
  const insertThought = db.prepare(`
    INSERT INTO thoughts
      (id, content, status, source, project_id, is_cluster, is_protected, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertVector = db.prepare(
    'INSERT OR REPLACE INTO vec_thoughts (id, embedding) VALUES (?, ?)'
  )
  const setImportance = db.prepare(
    'UPDATE thought_importance SET importance = ? WHERE thought_id = ?'
  )
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (id, source_id, target_id, type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)

  db.transaction(() => {
    for (const [index, thought] of scenario.thoughts.entries()) {
      const projectId = thought.projectId ?? 'default'
      insertProject.run(projectId, projectId, now)
      insertThought.run(
        thought.id,
        thought.content,
        thought.status ?? 'active',
        'eval',
        projectId,
        thought.isCluster ? 1 : 0,
        1,
        thought.createdAt ?? now,
        now
      )

      if (thought.importance !== undefined) setImportance.run(thought.importance, thought.id)

      const vector = vectors[index]
      insertVector.run(
        thought.id,
        Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
      )
    }

    for (const edge of scenario.edges ?? []) {
      insertEdge.run(crypto.randomUUID(), edge.source, edge.target, edge.type ?? 'related', now)
    }
  })()
}
