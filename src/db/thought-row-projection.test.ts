import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '.'
import { closeDb } from './init'
import { createProject } from './projects'
import { fetchThoughtsByIds, type SearchRecencyContext } from './search-hydrate'
import { findThoughtsByIdQuery } from './search-id'
import { listThoughts } from './thoughts'
import { createTestDb, seedThought } from '../test/helpers'

const PROJECT_NAME = 'Row Projection'
const PROJECT_PATH = '/work/row-projection'

const NO_RECENCY: SearchRecencyContext = {
  rrfMax: 0,
  recencyActive: false,
  recencyWeight: 0,
  recencyHalfLifeDays: 30,
  nowMs: Date.parse('2026-06-01T00:00:00.000Z')
}

const NO_HYDRATION = {
  vecSimById: new Map<string, number>(),
  bm25ScoreById: new Map<string, number>(),
  rrfScoreById: new Map<string, number>(),
  confidenceFloor: 0.5
}

let projectId: string
let thoughtId: string

beforeEach(() => {
  createTestDb()
  const project = createProject(getDb(), { name: PROJECT_NAME, local_path: PROJECT_PATH })
  projectId = project.id
  thoughtId = seedThought({ content: 'row projection marker', project_id: projectId })
})
afterEach(closeDb)

describe('project_name is populated by every thought-row projection', () => {
  test('the id-addressed lookup carries it for an exact id', () => {
    const results = findThoughtsByIdQuery(getDb(), thoughtId)

    expect(results).not.toBeNull()
    expect(results?.[0]?.thought.project_id).toBe(projectId)
    expect(results?.[0]?.thought.project_name).toBe(PROJECT_NAME)
  })

  test('the id-addressed lookup carries it for a prefix query too', () => {
    const prefix = thoughtId.replaceAll('-', '').slice(0, 13)
    const results = findThoughtsByIdQuery(getDb(), prefix)

    expect(results).not.toBeNull()
    expect(results?.map(result => result.thought.id)).toContain(thoughtId)
    for (const result of results ?? []) expect(result.thought.project_name).toBe(PROJECT_NAME)
  })

  test('hydration by ids carries it', () => {
    const results = fetchThoughtsByIds(
      getDb(),
      [thoughtId],
      { embedding: new Float32Array(0) },
      NO_HYDRATION,
      NO_RECENCY
    )

    expect(results).toHaveLength(1)
    expect(results[0].thought.project_id).toBe(projectId)
    expect(results[0].thought.project_name).toBe(PROJECT_NAME)
  })

  test('listThoughts carries it', () => {
    const thoughts = listThoughts(getDb(), { project_id: projectId })

    expect(thoughts).toHaveLength(1)
    expect(thoughts[0].id).toBe(thoughtId)
    expect(thoughts[0].project_name).toBe(PROJECT_NAME)
  })

  test('a thought whose project row is gone reports no name rather than a bogus one', () => {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(projectId)

    const [thought] = listThoughts(getDb(), { project_id: projectId })

    expect(thought.project_id).toBe(projectId)
    expect(thought.project_name).toBeUndefined()
  })
})

describe('the thought-row projection has one alias spelling', () => {
  const DB_DIR = import.meta.dir
  const SEARCH_CONSUMERS = ['search-id.ts', 'search-hydrate.ts']

  function sourceOf(file: string): string {
    return readFileSync(join(DB_DIR, file), 'utf8')
  }

  test('only thoughts.ts spells the alias, once', () => {
    const spellings = (sourceOf('thoughts.ts').match(/p\.name\s+as\s+project_name/gi) ?? []).length

    expect(spellings).toBe(1)
    expect(sourceOf('thoughts.ts')).toContain("export const THOUGHT_ROW_COLUMNS = 't.*, p.name as")
  })

  test('the search projections interpolate the shared columns and declare no alias of their own', () => {
    for (const file of SEARCH_CONSUMERS) {
      const source = sourceOf(file)

      expect(source).toContain('THOUGHT_ROW_COLUMNS')
      expect(source).toContain('THOUGHT_ROW_FROM')
      expect(source).not.toMatch(/p\.name\s+as\s+project_name/i)
    }
  })

  test('the row mapper reads one spelling, with no fallback that could mask a drift', () => {
    const source = sourceOf('thoughts.ts')

    expect((source.match(/row\.project_name/g) ?? []).length).toBe(1)
    expect(source).not.toMatch(/projectName/)
  })
})
