import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../src/db/container'
import { createEdge } from '../src/db/edges'
import { closeDb } from '../src/db/init'
import { createTestDb, seedThought } from '../src/test/helpers'
import { EVAL_SCENARIOS } from './datasets'
import { runEval } from './runner'
import { createDeterministicSearcher } from './search'

// Issue #124 item 3: the former xfail `supersession-old-not-current` scenario
// now gates as a normal pass, and the harness exercises the production search
// service (standing/suppression path) rather than the raw DB search bypass.

describe('supersession eval scenario (issue #124 item 3)', () => {
  beforeEach(createTestDb)
  afterEach(closeDb)

  test('scenario is a gated pass, not xfail/xpass', async () => {
    const scenario = EVAL_SCENARIOS.find(s => s.name === 'supersession-old-not-current')
    expect(scenario).toBeDefined()
    expect(scenario!.category).toBe('supersession')
    expect(scenario!.outcome).not.toBe('xfail')

    const res = await runEval({ scenarios: [scenario!] })
    const run = res.scenarios[0]
    expect(run.status).toBe('pass')
    expect(run.status).not.toBe('xfail')
    expect(run.status).not.toBe('xpass')
    expect(run.checkErrors).toEqual([])
    // The scenario now contributes real counts to the gated aggregate.
    expect(res.categories.supersession?.queries).toBe(1)
  })

  test('deterministic searcher suppresses via the service standing path', async () => {
    const query = 'supersessionevalservice'
    const oldThought = seedThought({ content: `${query} older replaced claim` })
    const newThought = seedThought({ content: `${query} newer claim` })
    createEdge(getDb(), newThought, oldThought, 'replaces')

    const found = await createDeterministicSearcher()(query, 10, undefined)
    const ids = found.map(r => r.thought.id)
    expect(ids).toContain(newThought)
    // The raw DB search would return both; only the service drops the stale one.
    expect(ids).not.toContain(oldThought)
    expect(found.every(r => r.standing === 'current')).toBe(true)
  })
})
