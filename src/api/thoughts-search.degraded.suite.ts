import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

mock.module('../embedder/client', () => ({
	generateEmbedding: async () => { throw new Error('embedder down') },
	generateEmbeddings: async () => { throw new Error('embedder down') },
	restartEmbedder: () => {},
	isEmbedderReady: () => false,
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

async function request(path: string): Promise<Response> {
	const headers = new Headers()
	headers.set('Authorization', 'Bearer test-token')
	return app.request(path, { headers })
}

beforeEach(createTestDb)
afterEach(closeDb)

test('GET /api/thoughts/search JSON includes degraded (true when degraded)', async () => {
	seedThought({ content: 'degradedhttp marker alpha' })
	const res = await request('/api/thoughts/search?q=degradedhttp')
	expect(res.status).toBe(200)
	const body = (await res.json()) as Array<{ thought: { id: string; content: string }; degraded?: boolean; signals?: unknown }>
	expect(Array.isArray(body)).toBe(true)
	expect(body.length).toBeGreaterThan(0)
	for (const r of body) {
		expect(typeof r.degraded).toBe('boolean')
		expect(r.degraded).toBe(true)
		expect(r.signals).toBeUndefined()
	}
})

test('GET /api/thoughts/search empty result is an array', async () => {
	const res = await request('/api/thoughts/search?q=zzzznomatchtoken-degradedhttp')
	expect(res.status).toBe(200)
	const body = (await res.json()) as unknown
	expect(Array.isArray(body)).toBe(true)
})
