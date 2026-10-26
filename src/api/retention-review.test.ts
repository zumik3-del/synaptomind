import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { createApp } from './router'

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { ...init, headers })
}

beforeEach(createTestDb)
afterEach(closeDb)

test('retention-review HTTP validates list query and maps validation to 400', async () => {
  const response = await request('/api/thoughts/retention-review?limit=0')
  expect(response.status).toBe(400)
  for (const query of ['minAgeDays=0', 'importanceFloor=2']) {
    const invalid = await request(`/api/thoughts/retention-review?${query}`)
    expect(invalid.status).toBe(400)
  }
})

test('retention-review HTTP lists candidates successfully', async () => {
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  const response = await request('/api/thoughts/retention-review')
  expect(response.status).toBe(200)
  const body = await response.json() as { candidates: Array<{ id: string }>; total: number }
  expect(body.candidates.map(row => row.id)).toContain(id)
  expect(body.total).toBe(1)
})

test('retention-review delete preview and confirmation preserve the preview-first contract', async () => {
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ?, created_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  const preview = await request(`/api/thoughts/${id}/retention-review/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  })
  expect(preview.status).toBe(200)
  expect((await preview.json() as { preview: boolean }).preview).toBe(true)
  const confirmed = await request(`/api/thoughts/${id}/retention-review/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true })
  })
  expect(confirmed.status).toBe(200)
  expect((await confirmed.json() as { deleted: boolean }).deleted).toBe(true)
})

test('retention-review delete treats absent, empty, and null bodies as previews', async () => {
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  for (const init of [
    { method: 'POST' },
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' }
  ]) {
    const response = await request(`/api/thoughts/${id}/retention-review/delete`, init)
    expect(response.status).toBe(200)
    expect((await response.json() as { preview: boolean }).preview).toBe(true)
    expect(getDb().prepare('SELECT id FROM thoughts WHERE id = ?').get(id)).toBeTruthy()
  }
})

test('retention-review delete returns 400 for malformed JSON', async () => {
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
  const response = await request(`/api/thoughts/${id}/retention-review/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  })
  expect(response.status).toBe(400)
})

test('retention-review compact rejects more than 1000 source IDs over HTTP', async () => {
  const response = await request('/api/thoughts/retention-review/compact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`), summary: { content: 'summary' } })
  })
  expect(response.status).toBe(400)
})

test('retention-review compact accepts 1000 source IDs through HTTP validation', async () => {
  const response = await request('/api/thoughts/retention-review/compact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_ids: Array.from({ length: 1000 }, (_, i) => `missing-${i}`), summary: { content: 'summary' } })
  })
  expect(response.status).not.toBe(400)
})

test('retention-review protect rejects an ineligible thought and missing delete maps to 404', async () => {
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-10-01T00:00:00.000Z' })
  const protectedResponse = await request(`/api/thoughts/${id}/retention-review/protect`, { method: 'POST' })
  expect(protectedResponse.status).toBe(409)
  expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({ is_protected: 0 })
  const missing = await request('/api/thoughts/no-such-id/retention-review/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true })
  })
  expect(missing.status).toBe(404)
})

test('retention-review protect marks an eligible candidate protected', async () => {
  const id = seedThought({ status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  const response = await request(`/api/thoughts/${id}/retention-review/protect`, { method: 'POST' })
  expect(response.status).toBe(200)
  expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({ is_protected: 1 })
  const candidates = await request('/api/thoughts/retention-review')
  expect((await candidates.json() as { candidates: Array<{ id: string }> }).candidates.map(candidate => candidate.id)).not.toContain(id)
})

test('retention-review compact validates bodies and returns a read-only preview', async () => {
  const invalid = await request('/api/thoughts/retention-review/compact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_ids: [], summary: { content: 'summary' } })
  })
  expect(invalid.status).toBe(400)
  const id = seedThought({ status: 'archived', is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ?, created_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  const preview = await request('/api/thoughts/retention-review/compact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_ids: [id], summary: { content: 'summary' } })
  })
  expect(preview.status).toBe(200)
  expect((await preview.json() as { preview: boolean }).preview).toBe(true)
})

test('retention-review compact confirmation creates the summary and returns API error mapping', async () => {
  const id = seedThought({ content: 'http compact source', status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-09-01T00:00:00.000Z' })
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  const response = await request('/api/thoughts/retention-review/compact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_ids: [id], summary: { content: 'http compact summary', tags: ['summary-tag'], project_id: 'default' }, confirm: true })
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { status: string; summary: { tags: Array<{ name: string }>; project_id: string } }
  expect(body.status).toBe('compacted')
  expect(body.summary.tags.map(tag => tag.name)).toContain('summary-tag')
  expect(body.summary.project_id).toBe('default')
  expect(getDb().prepare("SELECT id FROM thoughts WHERE content = 'http compact summary'").get()).toBeTruthy()
  const invalid = await request('/api/thoughts/retention-review/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
  expect(invalid.status).toBe(400)
})
