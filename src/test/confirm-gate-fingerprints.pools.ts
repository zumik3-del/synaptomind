/**
 * Pool-scoped rows of the per-input fingerprint matrix (task #2492): an action
 * whose token guards an aggregate rather than one row — the auto-cluster
 * candidate pool, a whole project with its thought count, and the primer set
 * entry. Test-only; the probe shape and the change helpers live in
 * `confirm-gate-fingerprints.types.ts`.
 */
import {
  age,
  anotherPrimer,
  anotherProject,
  autoClusterMembers,
  DRIFTED_AT,
  type FingerprintCase,
  type FingerprintProbe,
  freshThought,
  OLD,
  stringArg,
  update
} from './confirm-gate-fingerprints.types'
import { seedThought } from './helpers'

const AUTO_CLUSTER_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'planned.candidates': [
    {
      change: 'one candidate that joins no cluster (a new eligible thought)',
      refusal: 'stale',
      run: args => {
        seedThought({ content: 'gate cluster far member', created_at: OLD, is_protected: 0 })
        return args
      }
    }
  ],
  'planned.groups.length': [
    {
      change: 'the planned group count (min_members 3 -> 4 filters the group out)',
      refusal: 'stale',
      run: args => ({ ...args, min_members: 4 })
    }
  ],
  'group.members': [
    {
      change: 'the planned membership (one member out, one in)',
      refusal: 'stale',
      run: args => {
        const [first] = autoClusterMembers()
        update("UPDATE thoughts SET status = 'archived' WHERE id = ?", first)
        seedThought({ content: 'gate cluster member join', created_at: OLD, is_protected: 0 })
        return args
      }
    }
  ]
}

const MANAGE_DELETE_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'project.id': [
    {
      change: 'a confirm addressed to another project',
      refusal: 'target_mismatch',
      run: args => ({ ...args, project_id: anotherProject() })
    }
  ],
  'project.name': [
    {
      change: 'the project name',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE projects SET name = ? WHERE id = ?',
          'Gate drifted',
          stringArg(args, 'project_id')
        )
        return args
      }
    }
  ],
  'project.thought_count': [
    {
      change: 'the project thought count (0 -> 1)',
      refusal: 'stale',
      run: args => {
        seedThought({
          content: 'gate project thought',
          project_id: stringArg(args, 'project_id')
        })
        return args
      }
    }
  ]
}

const PRIMER_DELETE_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'primer.id': [
    {
      change: 'a confirm addressed to another primer',
      refusal: 'target_mismatch',
      run: args => ({ ...args, primer_id: anotherPrimer() })
    }
  ],
  'primer.thought_id': [
    {
      change: 'the primer thought',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE primers SET thought_id = ? WHERE id = ?',
          freshThought('primer move'),
          stringArg(args, 'primer_id')
        )
        return args
      }
    }
  ],
  'primer.hit_count': [
    {
      change: 'the primer hit count (+1)',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE primers SET hit_count = hit_count + 1 WHERE id = ?',
          stringArg(args, 'primer_id')
        )
        return args
      }
    }
  ],
  'primer.promoted_at': [
    {
      change: 'the primer promotion time',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE primers SET promoted_at = ? WHERE id = ?',
          DRIFTED_AT,
          stringArg(args, 'primer_id')
        )
        return args
      }
    }
  ],
  'primer.created_at': [
    {
      change: 'the primer creation time',
      refusal: 'stale',
      run: args => {
        age('primers', 'created_at')(stringArg(args, 'primer_id'))
        return args
      }
    }
  ]
}

export const POOL_FINGERPRINT_CASES: readonly FingerprintCase[] = [
  {
    label: 'memory_crystallize action=auto_cluster',
    kind: 'auto_cluster',
    module: 'src/mcp/tools/crystallize/auto-cluster.ts',
    probes: AUTO_CLUSTER_PROBES
  },
  {
    label: 'memory_manage action=delete',
    kind: 'manage_delete',
    module: 'src/mcp/tools/manage.ts',
    probes: MANAGE_DELETE_PROBES
  },
  {
    label: 'memory_primers action=delete',
    kind: 'primer_delete',
    module: 'src/mcp/tools/primers.ts',
    probes: PRIMER_DELETE_PROBES
  }
]
