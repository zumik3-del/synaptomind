import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { getThoughtRow } from '../db/thoughts'
import * as importanceDb from '../db/importance'
import { runDecayJob } from './decay.service'

beforeEach(createTestDb)
afterEach(() => { closeDb() })

/**
 * The decay job decays importance and nothing else.
 *
 * The auto-archive half was removed (task #1943): it archived active,
 * unprotected thoughts whose importance fell below the archive threshold and
 * whose age exceeded the archive minimum. Thoughts are created with
 * `is_protected = 1`, so that branch could not fire for them — it only
 * reached the few unprotected thoughts (clusters), whose lifecycle belongs to
 * the cluster services.
 *
 * The thresholds are spelled out as literals on purpose: the config keys
 * `decay.archiveThreshold` / `decay.archiveMinAgeDays` are no longer read by
 * any code, and the values used here (0.05 < 0.1, 60 d > 30 d) sit below and
 * above the former defaults.
 */
describe('runDecayJob', () => {
  test('decays importance of a stale low-importance thought', () => {
    const d = getDb()
    const id = seedThought({ status: 'active', is_protected: 0 })
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
    d.prepare(`UPDATE thought_importance SET importance = 0.8, last_decay = ? WHERE thought_id = ?`).run(twoDaysAgo, id)

    runDecayJob(d)

    const row = d.prepare(`SELECT importance FROM thought_importance WHERE thought_id = ?`).get(id) as {
      importance: number
    }
    expect(row.importance).toBeLessThan(0.8)
  })

  test('does not archive a stale low-importance thought', () => {
    const d = getDb()
    const id = seedThought({ status: 'active', is_protected: 0 })
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString()
    d.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(sixtyDaysAgo, id)
    d.prepare(`UPDATE thought_importance SET importance = 0.05, last_decay = ?, created_at = ? WHERE thought_id = ?`)
      .run(sixtyDaysAgo, sixtyDaysAgo, id)

    runDecayJob(d)

    // The branch is gone, not merely disabled: the thought stays active …
    expect(getThoughtRow(d, id)?.status).toBe('active')
    // … while the job still did its remaining half.
    const row = d.prepare(`SELECT importance FROM thought_importance WHERE thought_id = ?`).get(id) as {
      importance: number
    }
    expect(row.importance).toBeLessThan(0.05)
  })

  test('the auto-archive helper no longer exists in the db layer', () => {
    expect('archiveStaleLowImportance' in importanceDb).toBe(false)
  })
})
