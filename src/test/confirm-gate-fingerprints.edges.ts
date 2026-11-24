/**
 * Edge-scoped rows of the per-input fingerprint matrix (task #2492): the token is
 * bound to an edge id. Test-only; the probe shape and the change helpers live in
 * `confirm-gate-fingerprints.types.ts`.
 */
import {
  age,
  anotherEdge,
  type FingerprintCase,
  type FingerprintProbe,
  freshThought,
  stringArg,
  update
} from './confirm-gate-fingerprints.types'

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
  }
]
