/**
 * Edge-scoped rows of the confirm-gate fixture matrix (task #2466): the token is
 * bound to an edge id. Test-only; the shape and DB probes live in
 * `confirm-gate-cases.types.ts`.
 */
import { expect } from 'bun:test'
import { getDb } from '../db'
import { seedEdge, seedThought } from './helpers'
import { edgeExists, edgeTypeBetween, type GateCase } from './confirm-gate-cases.types'

function unlinkCase(): GateCase {
  let edgeId = ''
  return {
    label: 'memory_store action=unlink',
    kind: 'edge',
    tool: 'memory_store',
    replay: 'domain',
    setup() {
      const source = seedThought({ content: 'gate unlink source' })
      const target = seedThought({ content: 'gate unlink target' })
      edgeId = seedEdge(source, target, 'contradicts')
      return { action: 'unlink', edge_id: edgeId }
    },
    assertUntouched: () => expect(edgeExists(edgeId)).toBe(true),
    assertMutated: () => expect(edgeExists(edgeId)).toBe(false),
    drift(args) {
      getDb()
        .prepare("UPDATE edges SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
        .run(edgeId)
      return args
    }
  }
}

function retypeCase(): GateCase {
  let edgeId = ''
  let source = ''
  let target = ''
  return {
    label: 'memory_store action=retype',
    kind: 'edge',
    tool: 'memory_store',
    replay: 'domain',
    setup() {
      source = seedThought({ content: 'gate retype source' })
      target = seedThought({ content: 'gate retype target' })
      edgeId = seedEdge(source, target, 'contradicts')
      return { action: 'retype', edge_id: edgeId, new_type: 'supports' }
    },
    assertUntouched: () => expect(edgeTypeBetween(source, target)).toBe('contradicts'),
    assertMutated: () => expect(edgeTypeBetween(source, target)).toBe('supports'),
    drift(args) {
      getDb()
        .prepare("UPDATE edges SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
        .run(edgeId)
      return args
    }
  }
}

export const EDGE_GATE_CASES: readonly GateCase[] = [unlinkCase(), retypeCase()]
