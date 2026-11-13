import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  createTestDb,
  isVecExtensionAvailable,
  seedEmbedding,
  seedThought,
  withVecDb
} from '../test/helpers'
import { closeDb } from './init'
import { buildResidualFilterSQL, buildVecScopeSQL } from './search-filters'
import { addressedProjectShutOut, countFilteredVectors } from './search-vector'

const VEC_AVAILABLE = isVecExtensionAvailable()

/**
 * Vec-gated test. `:memory:` cannot load vec0, so each body runs on a fresh
 * file-backed DB supplied by `withVecDb` and skips when the extension is absent.
 */
function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

beforeEach(createTestDb)
afterEach(closeDb)

const PROJECT = 'proj-addressed'
const OTHER = 'proj-other'
const ABSENT = 'proj-absent'

interface RowSpec {
  project: string | null
  isGlobal: number
  vector: boolean
  status: 'active' | 'archived'
}

function seedRow(db: Database, spec: RowSpec): string {
  const label = `${spec.project ?? 'none'}-g${spec.isGlobal}-v${spec.vector ? 1 : 0}-${spec.status}`
  const id = seedThought({
    content: `matrix ${label}`,
    status: spec.status,
    project_id: spec.project ?? undefined,
    is_global: spec.isGlobal
  })
  if (spec.project === null) {
    db.prepare('UPDATE thoughts SET project_id = NULL WHERE id = ?').run(id)
  }
  if (spec.vector) seedEmbedding(id)
  return id
}

/** The 24-row matrix: project × is_global × vector × status. */
function seedMatrix(db: Database): void {
  for (const project of [PROJECT, OTHER, null]) {
    for (const isGlobal of [0, 1]) {
      for (const vector of [false, true]) {
        for (const status of ['active', 'archived'] as const) {
          seedRow(db, { project, isGlobal, vector, status })
        }
      }
    }
  }
}

const noResidual = () => buildResidualFilterSQL({})
const activeOnly = () => buildResidualFilterSQL({ statusFilter: 'active' })

describe('countFilteredVectors is exact across the 24-row matrix', () => {
  itVec('addressed project: 8 vector rows, of which 4 are active', db => {
    seedMatrix(db)
    const scope = buildVecScopeSQL({ projectFilter: PROJECT })

    expect(countFilteredVectors(db, scope, noResidual())).toBe(8)
    expect(countFilteredVectors(db, scope, activeOnly())).toBe(4)
  })

  itVec('a project with no rows of its own counts the 6 global vector rows', db => {
    seedMatrix(db)
    const scope = buildVecScopeSQL({ projectFilter: ABSENT })

    expect(countFilteredVectors(db, scope, noResidual())).toBe(6)
    expect(countFilteredVectors(db, scope, activeOnly())).toBe(3)
  })

  itVec('unscoped: all 12 vector rows count, of which 6 are active', db => {
    seedMatrix(db)
    const scope = buildVecScopeSQL({})

    expect(countFilteredVectors(db, scope, noResidual())).toBe(12)
    expect(countFilteredVectors(db, scope, activeOnly())).toBe(6)
  })
})

describe('countFilteredVectors skips rows without a stored vector', () => {
  itVec('a row without a vector is never counted', db => {
    seedThought({ content: 'unembedded own row', project_id: PROJECT })
    seedThought({ content: 'unembedded global row', project_id: OTHER, is_global: 1 })

    const scope = buildVecScopeSQL({ projectFilter: PROJECT })
    expect(countFilteredVectors(db, scope, noResidual())).toBe(0)
    expect(countFilteredVectors(db, buildVecScopeSQL({}), noResidual())).toBe(0)
  })

  itVec('an empty vector table yields 0 in every scope', db => {
    expect(
      countFilteredVectors(db, buildVecScopeSQL({ projectFilter: PROJECT }), noResidual())
    ).toBe(0)
    expect(countFilteredVectors(db, buildVecScopeSQL({}), noResidual())).toBe(0)
  })
})

describe('countFilteredVectors applies the residual to both branches', () => {
  itVec('a vector row excluded by the residual is not counted', db => {
    const kept = seedThought({ content: 'important own row', project_id: PROJECT })
    const lowOwn = seedThought({ content: 'lowly own row', project_id: PROJECT })
    const lowGlobal = seedThought({ content: 'lowly global row', project_id: OTHER, is_global: 1 })
    const setImportance = db.prepare(
      'UPDATE thought_importance SET importance = ? WHERE thought_id = ?'
    )
    setImportance.run(0.9, kept)
    setImportance.run(0.2, lowOwn)
    setImportance.run(0.2, lowGlobal)
    for (const id of [kept, lowOwn, lowGlobal]) seedEmbedding(id)

    const scope = buildVecScopeSQL({ projectFilter: PROJECT })
    expect(countFilteredVectors(db, scope, noResidual())).toBe(3)
    expect(countFilteredVectors(db, scope, buildResidualFilterSQL({ minImportance: 0.5 }))).toBe(1)
  })
})

describe('addressedProjectShutOut keeps its delivered-ids short-circuit', () => {
  itVec('a delivered own-project id clears the flag without probing the project', db => {
    const own = seedThought({ content: 'delivered own row', project_id: PROJECT })
    seedEmbedding(own)

    expect(addressedProjectShutOut(db, PROJECT, noResidual(), [{ id: own }])).toBe(false)
  })

  itVec('a delivered foreign id falls through to the project probe', db => {
    const foreign = seedThought({ content: 'delivered foreign row', project_id: OTHER })
    seedEmbedding(foreign)

    expect(addressedProjectShutOut(db, PROJECT, noResidual(), [{ id: foreign }])).toBe(false)

    const own = seedThought({ content: 'own row with a vector', project_id: PROJECT })
    seedEmbedding(own)
    expect(addressedProjectShutOut(db, PROJECT, noResidual(), [{ id: foreign }])).toBe(true)
  })

  itVec('an empty delivered list probes the project through the residual', db => {
    const archived = seedThought({
      content: 'archived own row with a vector',
      project_id: PROJECT,
      status: 'archived'
    })
    seedEmbedding(archived)

    expect(addressedProjectShutOut(db, PROJECT, activeOnly(), [])).toBe(false)
    expect(addressedProjectShutOut(db, PROJECT, noResidual(), [])).toBe(true)
  })
})
