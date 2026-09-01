import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { createVerifyEntry } from '../db/thought_verify'
import { runVerifyJob } from './thought_verify.service'

beforeEach(createTestDb)
afterEach(closeDb)

test('runVerifyJob returns zeros when no pending entries', async () => {
  const result = await runVerifyJob()
  expect(result.checked).toBe(0)
  expect(result.flagged).toBe(0)
})

test('runVerifyJob skips disabled via env', async () => {
  process.env.VERIFY_ENABLED = 'false'
  const result = await runVerifyJob()
  expect(result.checked).toBe(0)
  delete process.env.VERIFY_ENABLED
})

test('runVerifyJob checks entries', async () => {
  const db = getDb()
  const id = seedThought({ content: 'thought to verify' })
  createVerifyEntry(db, id)
  const result = await runVerifyJob()
  expect(result.checked).toBeGreaterThanOrEqual(1)
})
