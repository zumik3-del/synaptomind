/**
 * Thought-, project- and primer-scoped rows of the confirm-gate fixture matrix
 * (task #2466): the token is bound to a thought id, a thought batch, the
 * auto-cluster candidate pool, a project, or a primer. Test-only; the shape and
 * DB probes live in `confirm-gate-cases.types.ts`.
 */
import { expect } from 'bun:test'
import { getDb } from '../db/container'
import { promoteThoughtToPrimer } from '../db/primers'
import { createProjectService, getProjectService } from '../services/projects.service'
import { seedThought } from './helpers'
import {
  ageThought,
  clusterCount,
  type GateCase,
  OLD,
  primerExists,
  thoughtContent,
  thoughtExists,
  thoughtStatus
} from './confirm-gate-cases.types'

function autoClusterCase(): GateCase {
  return {
    label: 'memory_crystallize action=auto_cluster',
    kind: 'batch',
    tool: 'memory_crystallize',
    replay: 'token',
    setup() {
      for (let i = 0; i < 3; i++) {
        seedThought({ content: `gate cluster member ${i}`, created_at: OLD, is_protected: 0 })
      }
      return { action: 'auto_cluster', min_age_days: 0, min_similarity: 0.5, min_members: 3 }
    },
    assertUntouched: () => expect(clusterCount()).toBe(0),
    assertMutated: () => expect(clusterCount()).toBe(1),
    drift(args) {
      // One more eligible member changes the planned candidate pool.
      seedThought({ content: 'gate cluster drift member', created_at: OLD, is_protected: 0 })
      return args
    }
  }
}

function manageDeleteCase(): GateCase {
  let projectId = ''
  return {
    label: 'memory_manage action=delete',
    kind: 'other',
    tool: 'memory_manage',
    replay: 'domain',
    setup() {
      projectId = createProjectService({
        name: `Gate project ${Bun.randomUUIDv7()}`,
        local_path: `/tmp/gate-project-${Bun.randomUUIDv7()}`
      }).id
      return { action: 'delete', project_id: projectId }
    },
    assertUntouched: () => expect(getProjectService(projectId)).not.toBeNull(),
    assertMutated: () => expect(getProjectService(projectId)).toBeNull(),
    drift(args) {
      getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run('Gate drifted', projectId)
      return args
    }
  }
}

function archiveCase(): GateCase {
  let id = ''
  return {
    label: 'memory_supersede action=archive',
    kind: 'thought',
    tool: 'memory_supersede',
    replay: 'token',
    setup() {
      id = seedThought({ content: 'gate archive thought', status: 'active' })
      return { action: 'archive', thought_id: id }
    },
    assertUntouched: () => expect(thoughtStatus(id)).toBe('active'),
    assertMutated: () => expect(thoughtStatus(id)).toBe('archived'),
    drift(args) {
      ageThought(id)
      return args
    }
  }
}

function archiveBatchCase(): GateCase {
  let ids: string[] = []
  return {
    label: 'memory_supersede action=archive_batch',
    kind: 'batch',
    tool: 'memory_supersede',
    replay: 'token',
    setup() {
      ids = [
        seedThought({ content: 'gate batch archive one', status: 'active' }),
        seedThought({ content: 'gate batch archive two', status: 'active' })
      ]
      return { action: 'archive_batch', thought_ids: ids }
    },
    assertUntouched: () => expect(ids.map(thoughtStatus)).toEqual(['active', 'active']),
    assertMutated: () => expect(ids.map(thoughtStatus)).toEqual(['archived', 'archived']),
    drift(args) {
      ageThought(ids[0])
      return args
    }
  }
}

function mergeCase(): GateCase {
  let source = ''
  let target = ''
  return {
    label: 'memory_supersede action=merge',
    kind: 'thought',
    tool: 'memory_supersede',
    replay: 'token',
    setup() {
      source = seedThought({ content: 'gate merge source', status: 'active' })
      target = seedThought({ content: 'gate merge target', status: 'active' })
      return {
        action: 'merge',
        source_id: source,
        target_id: target,
        merged_content: 'gate merged content'
      }
    },
    assertUntouched: () => {
      expect(thoughtStatus(source)).toBe('active')
      expect(thoughtContent(target)).toBe('gate merge target')
    },
    assertMutated: () => {
      expect(thoughtStatus(source)).toBe('archived')
      expect(thoughtContent(target)).toBe('gate merged content')
    },
    drift: args => ({ ...args, merged_content: 'gate drifted content' })
  }
}

function retentionDeleteCase(): GateCase {
  let id = ''
  return {
    label: 'retention_review action=delete',
    kind: 'thought',
    tool: 'retention_review',
    replay: 'domain',
    setup() {
      id = seedThought({
        content: 'gate retention candidate',
        status: 'archived',
        is_protected: 0,
        importance: 0.1,
        created_at: '2026-09-01T00:00:00.000Z'
      })
      getDb()
        .prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?')
        .run('2026-09-01T00:00:00.000Z', id)
      // The INSERT trigger seeds thought_importance at 1.0, so the fixture sets
      // the low importance the eligibility floor needs after the fact.
      getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
      return { action: 'delete', thought_id: id }
    },
    assertUntouched: () => expect(thoughtExists(id)).toBe(true),
    assertMutated: () => expect(thoughtExists(id)).toBe(false),
    drift(args) {
      getDb().prepare('UPDATE thoughts SET is_protected = 1 WHERE id = ?').run(id)
      return args
    }
  }
}

function primerDeleteCase(): GateCase {
  let primerId = ''
  return {
    label: 'memory_primers action=delete',
    kind: 'other',
    tool: 'memory_primers',
    replay: 'domain',
    setup() {
      const thoughtId = seedThought({ content: 'gate primer candidate' })
      const primer = promoteThoughtToPrimer(getDb(), thoughtId, 12)
      expect(primer).not.toBeUndefined()
      primerId = primer!.id
      return { action: 'delete', primer_id: primerId }
    },
    assertUntouched: () => expect(primerExists(primerId)).toBe(true),
    assertMutated: () => expect(primerExists(primerId)).toBe(false),
    drift(args) {
      getDb().prepare('UPDATE primers SET hit_count = hit_count + 1 WHERE id = ?').run(primerId)
      return args
    }
  }
}

export const THOUGHT_GATE_CASES: readonly GateCase[] = [
  autoClusterCase(),
  manageDeleteCase(),
  archiveCase(),
  archiveBatchCase(),
  mergeCase(),
  retentionDeleteCase(),
  primerDeleteCase()
]
