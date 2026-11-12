/**
 * Edge-, run- and placement-scoped rows of the per-input fingerprint matrix
 * (task #2492): the token is bound to an edge id, a proposal id, or a batch/run
 * of them. Test-only; the probe shape and the change helpers live in
 * `confirm-gate-fingerprints.types.ts`.
 */
import {
  acceptedRowId,
  age,
  anotherEdge,
  anotherProposal,
  type FingerprintCase,
  type FingerprintProbe,
  freshThought,
  proposalColumn,
  stringArg,
  stringArrayArg,
  update
} from './confirm-gate-fingerprints.types'
import { edgeProposal } from './confirm-gate-cases.types'

const UNLINK_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'edge.id': [
    {
      change: 'a confirm addressed to another edge',
      refusal: 'target_mismatch',
      run: args => ({ ...args, edge_id: anotherEdge() })
    }
  ],
  'edge.source_id': [
    {
      change: 'the edge source thought',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE edges SET source_id = ? WHERE id = ?',
          freshThought('source'),
          stringArg(args, 'edge_id')
        )
        return args
      }
    }
  ],
  'edge.target_id': [
    {
      change: 'the edge target thought',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE edges SET target_id = ? WHERE id = ?',
          freshThought('target'),
          stringArg(args, 'edge_id')
        )
        return args
      }
    }
  ],
  'edge.type': [
    {
      change: "the edge type ('contradicts' -> 'related')",
      refusal: 'stale',
      run: args => {
        update("UPDATE edges SET type = 'related' WHERE id = ?", stringArg(args, 'edge_id'))
        return args
      }
    }
  ],
  'edge.created_at': [
    {
      change: 'the edge creation time',
      refusal: 'stale',
      run: args => {
        age('edges', 'created_at')(stringArg(args, 'edge_id'))
        return args
      }
    }
  ]
}

const RETYPE_PROBES: Record<string, readonly FingerprintProbe[]> = {
  // A retype folds the same edge row as an unlink, plus the requested type.
  ...UNLINK_PROBES,
  newType: [
    {
      change: "the requested type ('supports' -> 'related')",
      refusal: 'stale',
      run: args => ({ ...args, new_type: 'related' })
    }
  ]
}

const ROLLBACK_PROBES: Record<string, readonly FingerprintProbe[]> = {
  runId: [
    {
      change: 'a confirm addressed to another run',
      refusal: 'target_mismatch',
      run: args => ({ ...args, run_id: 'gate-fingerprint-other-run' })
    }
  ],
  'rows.length': [
    {
      change: 'one more accepted row in the run manifest',
      refusal: 'stale',
      run: args => {
        const runId = stringArg(args, 'run_id')
        edgeProposal(freshThought('manifest source'), freshThought('manifest target'), runId)
        return args
      }
    }
  ],
  'row.id, row.state': [
    {
      change: 'one manifest row leaving the accepted set',
      refusal: 'stale',
      run: args => {
        update(
          "UPDATE placement_proposals SET state = 'rolled_back', decided_at = ? WHERE id = ?",
          new Date().toISOString(),
          acceptedRowId(stringArg(args, 'run_id'))
        )
        return args
      }
    }
  ]
}

const APPLY_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'row.id': [
    {
      change: 'a confirm addressed to another proposal',
      refusal: 'target_mismatch',
      run: args => ({ ...args, proposal_id: anotherProposal() })
    }
  ],
  'row.state': [
    {
      change: "the proposal state ('pending' -> 'rejected')",
      refusal: 'stale',
      run: args => {
        proposalColumn('state', 'rejected')(stringArg(args, 'proposal_id'))
        return args
      }
    }
  ],
  'row.fingerprint': [
    {
      change: 'the proposal fingerprint',
      refusal: 'stale',
      run: args => {
        proposalColumn('fingerprint', 'drifted')(stringArg(args, 'proposal_id'))
        return args
      }
    }
  ],
  'row.created_at': [
    {
      change: 'the proposal creation time',
      refusal: 'stale',
      run: args => {
        age('placement_proposals', 'created_at')(stringArg(args, 'proposal_id'))
        return args
      }
    }
  ],
  'row.expires_at': [
    {
      change: 'the proposal expiry (empty -> a date)',
      refusal: 'stale',
      run: args => {
        proposalColumn('expires_at', '2030-01-01T00:00:00.000Z')(stringArg(args, 'proposal_id'))
        return args
      }
    }
  ],
  'row.result': [
    {
      change: 'the proposal result (empty -> a payload)',
      refusal: 'stale',
      run: args => {
        proposalColumn('result', '{"drifted":true}')(stringArg(args, 'proposal_id'))
        return args
      }
    }
  ],
  'row.run_id': [
    {
      change: 'the proposal run id (empty -> a run)',
      refusal: 'stale',
      run: args => {
        proposalColumn('run_id', 'gate-fingerprint-drifted-run')(stringArg(args, 'proposal_id'))
        return args
      }
    }
  ]
}

const APPLY_BATCH_PROBES: Record<string, readonly FingerprintProbe[]> = {
  proposalIds: [
    {
      change: "one proposal state ('pending' -> 'rejected')",
      refusal: 'stale',
      run: args => {
        proposalColumn('state', 'rejected')(stringArrayArg(args, 'proposal_ids')[0])
        return args
      }
    },
    {
      change: 'one proposal fingerprint',
      refusal: 'stale',
      run: args => {
        proposalColumn('fingerprint', 'drifted')(stringArrayArg(args, 'proposal_ids')[0])
        return args
      }
    },
    {
      change: 'one proposal creation time',
      refusal: 'stale',
      run: args => {
        age('placement_proposals', 'created_at')(stringArrayArg(args, 'proposal_ids')[0])
        return args
      }
    },
    {
      change: 'one proposal expiry (empty -> a date)',
      refusal: 'stale',
      run: args => {
        proposalColumn(
          'expires_at',
          '2030-01-01T00:00:00.000Z'
        )(stringArrayArg(args, 'proposal_ids')[0])
        return args
      }
    },
    {
      change: 'one proposal result (empty -> a payload)',
      refusal: 'stale',
      run: args => {
        proposalColumn('result', '{"drifted":true}')(stringArrayArg(args, 'proposal_ids')[0])
        return args
      }
    },
    {
      change: 'one proposal run id (empty -> a run)',
      refusal: 'stale',
      run: args => {
        proposalColumn(
          'run_id',
          'gate-fingerprint-drifted-run'
        )(stringArrayArg(args, 'proposal_ids')[0])
        return args
      }
    },
    {
      change: 'one proposal row disappearing from the batch',
      refusal: 'stale',
      run: args => {
        update(
          'DELETE FROM placement_proposals WHERE id = ?',
          stringArrayArg(args, 'proposal_ids')[1]
        )
        return args
      }
    }
  ]
}

export const EDGE_FINGERPRINT_CASES: readonly FingerprintCase[] = [
  {
    label: 'memory_store action=unlink',
    kind: 'unlink',
    module: 'src/mcp/tools/store/unlink.ts',
    probes: UNLINK_PROBES
  },
  {
    label: 'memory_store action=retype',
    kind: 'retype',
    module: 'src/mcp/tools/store/retype.ts',
    probes: RETYPE_PROBES
  },
  {
    label: 'edge_review action=rollback',
    kind: 'rollback',
    module: 'src/mcp/tools/review/rollback.ts',
    probes: ROLLBACK_PROBES
  },
  {
    label: 'edge_review action=apply',
    kind: 'apply',
    module: 'src/mcp/tools/review/apply.ts',
    probes: APPLY_PROBES
  },
  {
    label: 'edge_review action=apply_batch',
    kind: 'apply_batch',
    module: 'src/mcp/tools/review.ts',
    probes: APPLY_BATCH_PROBES
  }
]
