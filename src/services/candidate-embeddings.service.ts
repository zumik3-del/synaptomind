import type { Database } from 'bun:sqlite'
import { getPendingEmbeddingIds, getThoughtEmbeddingsBatch } from '../db/embeddings'

/** Minimal candidate shape the embedding resolver needs (id + content). */
interface EmbeddableCandidate {
  id: string
  content: string
}

/**
 * Embeddings for a candidate list, in candidate order.
 *
 * Stored `vec_thoughts` vectors are read in one batch query and the injected
 * `embed` function is called ONLY for the candidates that lack a current one —
 * no stored row at all, or a row queued in `pending_embeddings` whose content
 * changed after it was written — in candidate order. A run where every candidate
 * is already embedded and none is pending therefore makes zero embedder calls.
 *
 * Throws when the embedder returns the wrong number of vectors: `edge-detect`
 * and `auto-link` catch it and degrade to a no-op run, while `auto-cluster`
 * propagates it to its caller.
 */
export async function resolveCandidateEmbeddings(
  candidates: EmbeddableCandidate[],
  embed: (texts: string[]) => Promise<Float32Array[]>,
  db: Database
): Promise<Float32Array[]> {
  // Pending FIRST, then the stored vectors: a row the worker refreshes between
  // the two reads is still counted as pending, which costs one harmless extra
  // live embed. The reverse order could score a candidate from a vector that no
  // longer matches its content, so this ordering is deliberate, not incidental.
  const pending = getPendingEmbeddingIds(
    db,
    candidates.map(c => c.id)
  )
  const stored = getThoughtEmbeddingsBatch(
    db,
    candidates.map(c => c.id)
  )
  const missing = candidates.filter(c => !stored.has(c.id) || pending.has(c.id))
  if (missing.length === 0) return candidates.map(c => stored.get(c.id) as Float32Array)

  const generated = await embed(missing.map(c => c.content))
  if (generated.length !== missing.length) {
    throw new Error(`embedder returned ${generated.length} vectors for ${missing.length} candidates`)
  }
  missing.forEach((candidate, i) => {
    stored.set(candidate.id, generated[i])
  })
  return candidates.map(c => stored.get(c.id) as Float32Array)
}
