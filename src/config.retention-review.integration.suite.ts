import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalCwd = process.cwd()
const configDir = mkdtempSync(join(tmpdir(), 'synaptomind-retention-config-'))
process.chdir(configDir)
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ retentionReview: {
  pageSize: 10000, importanceFloor: -4, minAgeDays: 0
} }))

const { config } = await import('./config')
const { createTestDb, seedThought } = await import('./test/helpers')
const { getDb } = await import('./db/container')
const { closeDb } = await import('./db/init')
const { listRetentionReviewCandidatesService } = await import('./services/retention-review.service')

beforeAll(() => createTestDb())
afterAll(() => {
  closeDb()
  process.chdir(originalCwd)
  rmSync(configDir, { recursive: true, force: true })
})

test('invalid file retention-review bounds are sanitized before candidate listing', () => {
  expect(config.retentionReview).toEqual({ pageSize: 100, importanceFloor: 0, minAgeDays: 30 })
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  const result = listRetentionReviewCandidatesService({ now: '2026-10-23T00:00:00.000Z', importanceFloor: 0.2 }, getDb())
  expect(result.candidates.map(candidate => candidate.id)).toContain(id)
})
