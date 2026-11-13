import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { getThoughtRow } from '../db/thoughts'
import * as importanceDb from '../db/importance'
import { runDecayJob } from './decay.service'

beforeEach(createTestDb)
afterEach(() => {
  closeDb()
})

describe('runDecayJob', () => {
  test('decays importance of a stale low-importance thought', () => {
    const d = getDb()
    const id = seedThought({ status: 'active', is_protected: 0 })
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
    d.prepare(
      `UPDATE thought_importance SET importance = 0.8, last_decay = ? WHERE thought_id = ?`
    ).run(twoDaysAgo, id)

    runDecayJob(d)

    const row = d
      .prepare(`SELECT importance FROM thought_importance WHERE thought_id = ?`)
      .get(id) as {
      importance: number
    }
    expect(row.importance).toBeLessThan(0.8)
  })

  test('does not archive a stale low-importance thought', () => {
    const d = getDb()
    const id = seedThought({ status: 'active', is_protected: 0 })
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString()
    d.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(sixtyDaysAgo, id)
    d.prepare(
      `UPDATE thought_importance SET importance = 0.05, last_decay = ?, created_at = ? WHERE thought_id = ?`
    ).run(sixtyDaysAgo, sixtyDaysAgo, id)

    runDecayJob(d)

    expect(getThoughtRow(d, id)?.status).toBe('active')
    const row = d
      .prepare(`SELECT importance FROM thought_importance WHERE thought_id = ?`)
      .get(id) as {
      importance: number
    }
    expect(row.importance).toBeLessThan(0.05)
  })

  test('the auto-archive helper no longer exists in the db layer', () => {
    expect('archiveStaleLowImportance' in importanceDb).toBe(false)
  })
})
