/**
 * Default embedding-neighbour lookup for the placement engine (ADR 2026-09-28
 * §2.2). Shared by the plan assembler (`engine.ts`) and the placement proposer
 * (`placement.ts`) so both search the same active, same-project vector index.
 */

import type { Database } from 'bun:sqlite'
import { searchThoughts } from '../../db/search'
import type { SearchNeighborsFn } from '../edge-candidates.service'

/**
 * Active, same-project, vector-only neighbour lookup (`searchThoughts`). A
 * failing vector index degrades to "no neighbours" instead of throwing, so the
 * caller falls back to lexical-only signals.
 */
export function defaultSearchNeighbors(d: Database, projectId: string): SearchNeighborsFn {
  return (_id, embedding, k) => {
    try {
      return searchThoughts(d, {
        embedding,
        topK: k,
        statusFilter: 'active',
        projectFilter: projectId,
        hybrid: false
      }).map(r => ({ id: r.thought.id, similarity: r.similarity }))
    } catch (err) {
      console.debug('[placement] neighbour search failed:', err)
      return []
    }
  }
}
