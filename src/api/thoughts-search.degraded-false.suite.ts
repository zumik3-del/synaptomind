import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { closeDb, initDb } from '../db/init'
import { seedThought } from '../test/helpers'
import { createApp } from './router'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('../embedder/client', () => ({
	generateEmbedding: async () => new Float32Array(384),
	generateEmbeddings: async () => [new Float32Array(384)],
	restartEmbedder: () => {},
	isEmbedderReady: () => true,
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

let tmpDir: string
async function request(path: string): Promise<Response> {
	const headers = new Headers()
	headers.set('Authorization', 'Bearer test-token')
	return app.request(path, { headers })
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'synaptomind-http-'))
	initDb({ dbPath: join(tmpDir, 'test.db'), runMigrations: true })
})
afterEach(() => {
	closeDb()
	rmSync(tmpDir, { recursive: true, force: true })
})

test('GET /api/thoughts/search JSON includes degraded (false when healthy)', async () => {
	seedThought({ content: 'degradedhttp healthy marker' })
	const res = await request('/api/thoughts/search?q=degradedhttp')
	expect(res.status).toBe(200)
	const body = (await res.json()) as Array<{ thought: { id: string; content: string }; degraded?: boolean; signals?: unknown }>
	expect(Array.isArray(body)).toBe(true)
	expect(body.length).toBeGreaterThan(0)
	for (const r of body) {
		expect(typeof r.degraded).toBe('boolean')
		expect(r.degraded).toBe(false)
		expect(r.signals).toBeUndefined()
	}
})
