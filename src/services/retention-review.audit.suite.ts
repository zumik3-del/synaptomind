import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb } from '../db/init'

const entries: Array<{ level: string; type: string; message: string; metadata?: Record<string, unknown> }> = []
mock.module('../logging/log', () => ({ insertLog: (...args: [string, string, string, Record<string, unknown>?]) => entries.push({ level: args[0], type: args[1], message: args[2], metadata: args[3] }) }))
const { getDb } = await import('../db/container')
const { deleteRetentionReviewCandidateService, protectRetentionReviewCandidateService, compactRetentionReviewCandidatesService } = await import('./retention-review-actions.service')
const now = '2026-10-23T00:00:00.000Z'
function candidate(content: string) { const id = seedThought({ content, status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-09-01T00:00:00.000Z' }); getDb().prepare('UPDATE thought_importance SET importance=0.1 WHERE thought_id=?').run(id); getDb().prepare('UPDATE thoughts SET archived_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z', id); return id }
beforeEach(() => { createTestDb(); entries.length = 0 })
afterEach(closeDb)
test('logs once only after confirmed delete, protect, and compact with required metadata', () => {
 const del = candidate('delete'); deleteRetentionReviewCandidateService(del, { now, minAgeDays: 30, importanceFloor: 0.5, confirm: true }, getDb())
 expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ level: 'info', type: 'retention-review', metadata: { thought_id: del } })
 const protectedId = candidate('protect'); protectRetentionReviewCandidateService(protectedId, { now, minAgeDays: 30, importanceFloor: 0.5 }, getDb())
 expect(entries).toHaveLength(2); expect(entries[1]).toMatchObject({ level: 'info', type: 'retention-review', metadata: { thought_id: protectedId } })
 const source = candidate('compact'); const result = compactRetentionReviewCandidatesService({ source_ids: [source], summary: { content: 'summary' }, now, minAgeDays: 30, importanceFloor: 0.5, confirm: true }, getDb())
 expect(entries).toHaveLength(3); expect(entries[2]).toMatchObject({ level: 'info', type: 'retention-review', metadata: { summary_id: result.summary?.id, source_ids: [source] } })
})
test('previews and rolled-back confirmation emit no audit log', () => {
 const previewId = candidate('preview'); deleteRetentionReviewCandidateService(previewId, { now, minAgeDays: 30, importanceFloor: 0.5 }, getDb())
 expect(entries).toHaveLength(0)
 const first = candidate('rollback one'); const second = candidate('rollback two')
 getDb().exec(`CREATE TRIGGER fail_late BEFORE UPDATE OF status ON thoughts WHEN OLD.id='${second}' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`)
 expect(() => compactRetentionReviewCandidatesService({ source_ids: [first, second], summary: { content: 'rollback summary' }, now, minAgeDays: 30, importanceFloor: 0.5, confirm: true }, getDb())).toThrow('forced rollback')
 expect(entries).toHaveLength(0); expect(getDb().prepare('SELECT status FROM thoughts WHERE id=?').get(first)).toEqual({ status: 'archived' })
 expect(getDb().prepare("SELECT id FROM thoughts WHERE content='rollback summary'").get()).toBeNull()
})
