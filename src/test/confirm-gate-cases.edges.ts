/**
 * Edge- and placement-scoped rows of the confirm-gate fixture matrix (task
 * #2466): the token is bound to an edge id, a proposal id, or a batch/run of
 * them. Test-only; the shape and DB probes live in `confirm-gate-cases.types.ts`.
 */
import { expect } from 'bun:test'
import { getDb } from '../context/container'
import { seedEdge, seedThought } from './helpers'
import {
  edgeExists,
  edgeProposal,
  edgeTypeBetween,
  type GateCase,
  proposalState,
  ROLLBACK_RUN
} from './confirm-gate-cases.types'

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

function rollbackCase(): GateCase {
  let proposals: string[] = []
  let pairs: Array<{ source: string; target: string }> = []
  return {
    label: 'edge_review action=rollback',
    kind: 'batch',
    tool: 'edge_review',
    replay: 'token',
    setup() {
      pairs = [0, 1].map(i => ({
        source: seedThought({ content: `gate rollback source ${i}`, status: 'active' }),
        target: seedThought({ content: `gate rollback target ${i}`, status: 'active' })
      }))
      proposals = pairs.map(pair => edgeProposal(pair.source, pair.target, ROLLBACK_RUN))
      return { action: 'rollback', run_id: ROLLBACK_RUN }
    },
    assertUntouched: () => {
      // A revert always deletes the edge; the edges still being there is the
      // mutation-free proof (drift below legitimately moves one row's state).
      for (const pair of pairs) expect(edgeTypeBetween(pair.source, pair.target)).toBe('related')
    },
    assertMutated: () => {
      for (const pair of pairs) expect(edgeTypeBetween(pair.source, pair.target)).toBeNull()
      expect(proposals.map(proposalState)).toEqual(['rolled_back', 'rolled_back'])
    },
    drift(args) {
      // The manifest shrinks, so the run fingerprint a preview minted no longer matches.
      getDb()
        .prepare(
          "UPDATE placement_proposals SET state = 'rolled_back', decided_at = ? WHERE id = ?"
        )
        .run(new Date().toISOString(), proposals[0])
      return args
    }
  }
}

function applyCase(): GateCase {
  let proposalId = ''
  const pair = { source: '', target: '' }
  return {
    label: 'edge_review action=apply',
    kind: 'batch',
    tool: 'edge_review',
    replay: 'token',
    setup() {
      pair.source = seedThought({ content: 'gate apply source', status: 'active' })
      pair.target = seedThought({ content: 'gate apply target', status: 'active' })
      proposalId = edgeProposal(pair.source, pair.target)
      return { action: 'apply', proposal_id: proposalId }
    },
    assertUntouched: () => {
      // The only mutation is the edge; there being none proves the dry run.
      expect(edgeTypeBetween(pair.source, pair.target)).toBeNull()
    },
    assertMutated: () => {
      expect(proposalState(proposalId)).toBe('accepted')
      expect(edgeTypeBetween(pair.source, pair.target)).toBe('related')
    },
    drift(args) {
      getDb()
        .prepare("UPDATE placement_proposals SET state = 'rejected' WHERE id = ?")
        .run(proposalId)
      return args
    }
  }
}

function applyBatchCase(): GateCase {
  let proposals: string[] = []
  let pairs: Array<{ source: string; target: string }> = []
  return {
    label: 'edge_review action=apply_batch',
    kind: 'batch',
    tool: 'edge_review',
    replay: 'token',
    setup() {
      pairs = [0, 1].map(i => ({
        source: seedThought({ content: `gate apply batch source ${i}`, status: 'active' }),
        target: seedThought({ content: `gate apply batch target ${i}`, status: 'active' })
      }))
      proposals = pairs.map(pair => edgeProposal(pair.source, pair.target))
      return { action: 'apply_batch', proposal_ids: proposals }
    },
    assertUntouched: () => {
      // The only mutation is the edges; none existing proves the dry run
      // (drift below legitimately moves one row's state).
      for (const pair of pairs) expect(edgeTypeBetween(pair.source, pair.target)).toBeNull()
    },
    assertMutated: () => {
      expect(proposals.map(proposalState)).toEqual(['accepted', 'accepted'])
      for (const pair of pairs) expect(edgeTypeBetween(pair.source, pair.target)).toBe('related')
    },
    drift(args) {
      getDb()
        .prepare("UPDATE placement_proposals SET state = 'rejected' WHERE id = ?")
        .run(proposals[0])
      return args
    }
  }
}

export const EDGE_GATE_CASES: readonly GateCase[] = [
  unlinkCase(),
  retypeCase(),
  rollbackCase(),
  applyCase(),
  applyBatchCase()
]
