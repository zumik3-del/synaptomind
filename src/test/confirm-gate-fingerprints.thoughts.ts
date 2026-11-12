/**
 * Thought-scoped rows of the per-input fingerprint matrix (task #2492): the
 * token is bound to a thought id, a thought batch, or the merge's source and
 * target pair. Test-only; the probe shape and the change helpers live in
 * `confirm-gate-fingerprints.types.ts`.
 */
import {
  age,
  db,
  anotherArchivedThought,
  anotherProject,
  type FingerprintCase,
  type FingerprintProbe,
  freshThought,
  stringArg,
  stringArrayArg,
  update
} from './confirm-gate-fingerprints.types'

const ARCHIVE_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'existing.id': [
    {
      change: 'a confirm addressed to another thought',
      refusal: 'target_mismatch',
      run: args => ({ ...args, thought_id: freshThought('bound archive') })
    }
  ],
  'existing.status': [
    {
      change: "the thought status ('active' -> 'draft')",
      refusal: 'stale',
      run: args => {
        update("UPDATE thoughts SET status = 'draft' WHERE id = ?", stringArg(args, 'thought_id'))
        return args
      }
    }
  ],
  'existing.updated_at': [
    {
      change: 'the thought update time',
      refusal: 'stale',
      run: args => {
        age('thoughts', 'updated_at')(stringArg(args, 'thought_id'))
        return args
      }
    }
  ],
  'existing.is_protected': [
    {
      change: 'the thought protection flag (1 -> 0)',
      refusal: 'stale',
      run: args => {
        update('UPDATE thoughts SET is_protected = 0 WHERE id = ?', stringArg(args, 'thought_id'))
        return args
      }
    }
  ]
}

const ARCHIVE_BATCH_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'thoughts.map': [
    {
      change: "one thought status ('active' -> 'draft')",
      refusal: 'stale',
      run: args => {
        update(
          "UPDATE thoughts SET status = 'draft' WHERE id = ?",
          stringArrayArg(args, 'thought_ids')[0]
        )
        return args
      }
    },
    {
      change: 'one thought update time',
      refusal: 'stale',
      run: args => {
        age('thoughts', 'updated_at')(stringArrayArg(args, 'thought_ids')[0])
        return args
      }
    },
    {
      change: 'one thought protection flag (1 -> 0)',
      refusal: 'stale',
      run: args => {
        update(
          'UPDATE thoughts SET is_protected = 0 WHERE id = ?',
          stringArrayArg(args, 'thought_ids')[0]
        )
        return args
      }
    },
    {
      change: 'one thought of the batch disappearing (the missing branch)',
      refusal: 'stale',
      run: args => {
        update('DELETE FROM thoughts WHERE id = ?', stringArrayArg(args, 'thought_ids')[1])
        return args
      }
    }
  ]
}

const MERGE_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'source.id, source.status': [
    {
      change: "the source status ('active' -> 'draft')",
      refusal: 'stale',
      run: args => {
        update("UPDATE thoughts SET status = 'draft' WHERE id = ?", stringArg(args, 'source_id'))
        return args
      }
    },
    {
      change: 'the source update time',
      refusal: 'stale',
      run: args => {
        age('thoughts', 'updated_at')(stringArg(args, 'source_id'))
        return args
      }
    },
    {
      change: 'the source protection flag (1 -> 0)',
      refusal: 'stale',
      run: args => {
        update('UPDATE thoughts SET is_protected = 0 WHERE id = ?', stringArg(args, 'source_id'))
        return args
      }
    }
  ],
  'target.id, target.status': [
    {
      change: "the target status ('active' -> 'draft')",
      refusal: 'stale',
      run: args => {
        update("UPDATE thoughts SET status = 'draft' WHERE id = ?", stringArg(args, 'target_id'))
        return args
      }
    },
    {
      change: 'the target update time',
      refusal: 'stale',
      run: args => {
        age('thoughts', 'updated_at')(stringArg(args, 'target_id'))
        return args
      }
    },
    {
      change: 'the target protection flag (1 -> 0)',
      refusal: 'stale',
      run: args => {
        update('UPDATE thoughts SET is_protected = 0 WHERE id = ?', stringArg(args, 'target_id'))
        return args
      }
    }
  ],
  mergedContent: [
    {
      change: 'the replacement content',
      refusal: 'stale',
      run: args => ({ ...args, merged_content: 'gate fingerprint drifted content' })
    }
  ],
  mergedTags: [
    {
      change: 'the merged tags (none -> one)',
      refusal: 'stale',
      run: args => ({ ...args, merged_tags: ['gate-fingerprint'] })
    }
  ],
  projectFilter: [
    {
      change: 'the resolved project (no cwd -> another project)',
      refusal: 'stale',
      run: args => {
        const project = anotherProject()
        const path = db().prepare('SELECT local_path FROM projects WHERE id = ?').get(project) as {
          local_path: string
        }
        return { ...args, cwd: path.local_path }
      }
    }
  ]
}

const RETENTION_DELETE_PROBES: Record<string, readonly FingerprintProbe[]> = {
  'thought.id': [
    {
      change: 'a confirm addressed to another thought',
      refusal: 'target_mismatch',
      run: args => ({ ...args, thought_id: anotherArchivedThought() })
    }
  ],
  'thought.status': [
    {
      change: "the thought status ('archived' -> 'active')",
      refusal: 'stale',
      run: args => {
        update("UPDATE thoughts SET status = 'active' WHERE id = ?", stringArg(args, 'thought_id'))
        return args
      }
    }
  ],
  'thought.created_at': [
    {
      change: 'the thought creation time',
      refusal: 'stale',
      run: args => {
        age('thoughts', 'created_at')(stringArg(args, 'thought_id'))
        return args
      }
    }
  ],
  'thought.is_protected': [
    {
      change: 'the thought protection flag (0 -> 1)',
      refusal: 'stale',
      run: args => {
        update('UPDATE thoughts SET is_protected = 1 WHERE id = ?', stringArg(args, 'thought_id'))
        return args
      }
    }
  ]
}

export const THOUGHT_FINGERPRINT_CASES: readonly FingerprintCase[] = [
  {
    label: 'memory_supersede action=archive',
    kind: 'archive',
    module: 'src/mcp/tools/supersede.ts',
    probes: ARCHIVE_PROBES
  },
  {
    label: 'memory_supersede action=archive_batch',
    kind: 'archive_batch',
    module: 'src/mcp/tools/supersede.ts',
    probes: ARCHIVE_BATCH_PROBES
  },
  {
    label: 'memory_supersede action=merge',
    kind: 'merge',
    module: 'src/mcp/tools/supersede.ts',
    probes: MERGE_PROBES
  },
  {
    label: 'retention_review action=delete',
    kind: 'retention_delete',
    module: 'src/mcp/tools/retention-review.ts',
    probes: RETENTION_DELETE_PROBES
  }
]
