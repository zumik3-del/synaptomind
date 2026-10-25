import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

const restartEmbedderMock = mock(() => {})

mock.module('../embedder/client', () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	restartEmbedder: restartEmbedderMock,
	isEmbedderReady: () => true,
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

async function request(path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers)
	headers.set('Authorization', 'Bearer test-token')
	return app.request(path, { ...init, headers })
}

beforeEach(createTestDb)
afterEach(closeDb)

test('GET /api/health-check ignores ?fix=true and does not archive thoughts', async () => {
	const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const res = await request('/api/health-check?fix=true')
	expect(res.status).toBe(200)

	const row = getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(clusterId) as { status: string }
	expect(row.status).toBe('active')
})

test('POST /api/health-check/repair previews without mutating and returns a token', async () => {
	seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const res = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({}),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { status: string; preview_token?: string; repairable?: unknown[] }
	expect(body.status).toBe('preview')
	expect(typeof body.preview_token).toBe('string')
})

test('POST /api/health-check/repair requires preview_token when confirm=true', async () => {
	seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const res = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({ confirm: true }),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(res.status).not.toBe(200)
})

test('POST /api/health-check/repair archives (not deletes) thoughts after preview+confirm', async () => {
	const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const previewRes = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({}),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(previewRes.status).toBe(200)
	const preview = (await previewRes.json()) as { preview_token: string }

	const execRes = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({ confirm: true, preview_token: preview.preview_token }),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(execRes.status).toBe(200)
	const exec = (await execRes.json()) as { status: string }
	expect(exec.status).toBe('executed')

	const row = getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(clusterId) as { status: string } | undefined
	expect(row).toBeDefined()
	expect(row!.status).toBe('archived')
})

test('POST /api/health-check/repair returns 400 on missing preview_token', async () => {
	seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const res = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({ confirm: true }),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(res.status).toBe(400)
})

test('POST /api/health-check/repair returns 400 on bogus preview_token', async () => {
	seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const res = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({ confirm: true, preview_token: 'bogus-token' }),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(res.status).toBe(400)
})

test('POST /api/health-check/repair returns 400 on replayed preview_token', async () => {
	seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

	const previewRes = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({}),
		headers: { 'Content-Type': 'application/json' },
	})
	const preview = (await previewRes.json()) as { preview_token: string }

	const first = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({ confirm: true, preview_token: preview.preview_token }),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(first.status).toBe(200)

	const replay = await request('/api/health-check/repair', {
		method: 'POST',
		body: JSON.stringify({ confirm: true, preview_token: preview.preview_token }),
		headers: { 'Content-Type': 'application/json' },
	})
	expect(replay.status).toBe(400)
})
