import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { seedEdge, seedThought, createTestDb } from '../test/helpers'
import { computeContentHash } from '../utils'
import {
  compactRetentionReviewCandidatesService,
  deleteRetentionReviewCandidateService,
  listRetentionReviewCandidatesService,
  protectRetentionReviewCandidateService,
  RetentionReviewIneligibleError
} from './retention-review.service'

const now = '2026-10-23T00:00:00.000Z'
const old = '2026-09-01T00:00:00.000Z'

function candidate(content: string, project_id = 'default'): string {
  const id = seedThought({ content, status: 'archived', project_id, is_protected: 0, importance: 0.1, created_at: old })
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run(old, id)
  return id
}

beforeEach(createTestDb)
afterEach(closeDb)

test('candidate query includes aged archived and draft thoughts and supplies missing importance defaults', () => {
  const archived = candidate('archived')
  const draft = seedThought({ content: 'draft', status: 'draft', is_protected: 0, importance: 0.1, created_at: old })
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(draft)
  const missingImportance = candidate('missing importance')
  getDb().prepare('DELETE FROM thought_importance WHERE thought_id = ?').run(missingImportance)

  const result = listRetentionReviewCandidatesService({ now, minAgeDays: 30, importanceFloor: 1 })
  expect(result.candidates.map(row => row.id)).toEqual([archived, draft])
  expect(result.total).toBe(2)
})

test('candidate query excludes each ineligible signal and respects age and importance boundaries', () => {
  const keep = candidate('eligible')
  const recent = seedThought({ status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-10-01T00:00:00.000Z' })
  const highImportance = candidate('high importance')
  getDb().prepare('UPDATE thought_importance SET importance = 0.5 WHERE thought_id = ?').run(highImportance)
  const hit = candidate('used')
  getDb().prepare('UPDATE thought_importance SET hit_count = 1 WHERE thought_id = ?').run(hit)
  seedThought({ status: 'archived', is_protected: 1, importance: 0.1, created_at: old })
  const globallyShared = seedThought({ status: 'archived', is_protected: 0, is_global: 1, importance: 0.1, created_at: old })
  const future = seedThought({ status: 'archived', is_protected: 0, importance: 0.1, created_at: old, surface_after: '2026-10-24T00:00:00.000Z' })
  const target = candidate('incoming active')
  const source = seedThought({ status: 'active', is_protected: 0 })
  seedEdge(source, target)
  seedThought({ status: 'active', is_protected: 0, importance: 0.1, created_at: old })
  const result = listRetentionReviewCandidatesService({ now, minAgeDays: 30, importanceFloor: 0.5 })
  expect(result.candidates.map(row => row.id)).toEqual([keep])
  expect(result.candidates.map(row => row.id)).not.toContain(globallyShared)
  expect(result.candidates.map(row => row.id)).not.toContain(future)
  expect(recent).not.toBe(keep)
})

test('candidate pagination preserves stable order and returns unpaged total', () => {
  const ids = [candidate('a'), candidate('b'), candidate('c')]
  const page = listRetentionReviewCandidatesService({ now, minAgeDays: 30, importanceFloor: 1, limit: 1, offset: 1 })
  expect(page.total).toBe(3)
  expect(page.candidates.map(row => row.id)).toEqual([ids[1]])
})

test('delete previews without mutation, then confirms hard deletion and dependent cascade', () => {
  const id = candidate('delete me')
  const related = seedThought({ is_protected: 0 })
  seedEdge(id, related)
  const preview = deleteRetentionReviewCandidateService(id, { now, minAgeDays: 30, importanceFloor: 1 })
  expect(preview.preview).toBe(true)
  expect(getDb().prepare('SELECT id FROM thoughts WHERE id = ?').get(id)).toBeTruthy()
  const deleted = deleteRetentionReviewCandidateService(id, { now, minAgeDays: 30, importanceFloor: 1, confirm: true })
  expect(deleted.deleted).toBe(true)
  expect(getDb().prepare('SELECT id FROM thoughts WHERE id = ?').get(id)).toBeNull()
  expect(getDb().prepare('SELECT id FROM edges WHERE source_id = ? OR target_id = ?').all(id, id)).toEqual([])
})

test('delete rejects missing, protected and no-longer-eligible thoughts', () => {
  const id = candidate('protect')
  expect(() => deleteRetentionReviewCandidateService('missing', { now, minAgeDays: 30, importanceFloor: 1 })).toThrow()
  protectRetentionReviewCandidateService(id)
  expect(() => deleteRetentionReviewCandidateService(id, { now, minAgeDays: 30, importanceFloor: 1 })).toThrow(RetentionReviewIneligibleError)
  const other = candidate('became active')
  getDb().prepare("UPDATE thoughts SET status = 'active' WHERE id = ?").run(other)
  expect(() => deleteRetentionReviewCandidateService(other, { now, minAgeDays: 30, importanceFloor: 1 })).toThrow(RetentionReviewIneligibleError)
})

test('compact preview is read-only; confirmation creates protected summary and archives source', () => {
  const id = candidate('compact source')
  const input = { source_ids: [id], summary: { content: 'durable summary' }, now, minAgeDays: 30, importanceFloor: 1 }
  expect(compactRetentionReviewCandidatesService(input).status).toBe('preview')
  expect(getDb().prepare("SELECT id FROM thoughts WHERE content = 'durable summary'").get()).toBeNull()
  const result = compactRetentionReviewCandidatesService({ ...input, confirm: true })
  expect(result.status).toBe('compacted')
  expect(result.summary).toBeTruthy()
  expect(getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(id)).toEqual({ status: 'archived' })
})

test('compact refuses mixed projects and matching existing active content without mutations', () => {
  const a = candidate('source a', 'default')
  const b = candidate('source b', 'second')
  const options = { source_ids: [a, b], summary: { content: 'new summary' }, now, minAgeDays: 30, importanceFloor: 1 }
  expect(() => compactRetentionReviewCandidatesService({ ...options, confirm: true })).toThrow('same project')
  const single = candidate('source c')
  const existing = seedThought({ content: 'duplicate summary', status: 'active', is_protected: 0 })
  getDb().prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run(computeContentHash('duplicate summary', 'default'), existing)
  expect(() => compactRetentionReviewCandidatesService({ source_ids: [single], summary: { content: 'duplicate summary' }, now, minAgeDays: 30, importanceFloor: 1, confirm: true })).toThrow('matches an existing')
  expect(getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(single)).toEqual({ status: 'archived' })
})

test('compact transfers source edges and records summary-to-source replacement edges', () => {
  const source = candidate('edge source')
  const related = seedThought({ content: 'related thought', status: 'active', is_protected: 0 })
  seedEdge(source, related)

  const result = compactRetentionReviewCandidatesService({
    source_ids: [source], summary: { content: 'edge summary' }, now, minAgeDays: 30, importanceFloor: 1, confirm: true
  })

  const summaryId = result.summary?.id
  expect(summaryId).toBeTruthy()
  if (!summaryId) throw new Error('Expected compacted summary ID')
  expect(getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(source)).toEqual({ status: 'archived' })
  expect(getDb().prepare('SELECT source_id, target_id, type FROM edges WHERE source_id = ? OR target_id = ?').all(summaryId, summaryId)).toContainEqual({ source_id: summaryId, target_id: source, type: 'replaces' })
  expect(getDb().prepare('SELECT source_id, target_id FROM edges WHERE source_id = ? AND target_id = ?').get(summaryId, related)).toBeTruthy()
})

test('compact confirmation rolls back summary and earlier source mutations when a later source merge fails', () => {
  const first = candidate('rollback source one')
  const second = candidate('rollback source two')
  getDb().exec(`CREATE TRIGGER fail_second_compact_source BEFORE UPDATE OF status ON thoughts
    WHEN OLD.id = '${second}' BEGIN SELECT RAISE(ABORT, 'forced compact failure'); END`)

  expect(() => compactRetentionReviewCandidatesService({
    source_ids: [first, second], summary: { content: 'rollback summary' }, now, minAgeDays: 30, importanceFloor: 1, confirm: true
  })).toThrow('forced compact failure')
  expect(getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(first)).toEqual({ status: 'archived' })
  expect(getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(second)).toEqual({ status: 'archived' })
  expect(getDb().prepare("SELECT id FROM thoughts WHERE content = 'rollback summary'").all()).toEqual([])
})

test('protect rejects thoughts that are no longer retention-review candidates', () => {
  const id = candidate('not eligible for protection')
  getDb().prepare('UPDATE thought_importance SET hit_count = 1 WHERE thought_id = ?').run(id)
  expect(() => protectRetentionReviewCandidateService(id, { now, minAgeDays: 30, importanceFloor: 1 })).toThrow(RetentionReviewIneligibleError)
  expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({ is_protected: 0 })
})
