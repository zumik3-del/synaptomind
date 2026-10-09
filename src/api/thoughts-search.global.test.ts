import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { closeDb } from "../db/init";
import { createTestDb, seedThought } from "../test/helpers";
import { createApp } from "./router";

// HTTP surface coverage for the is_global flag (epic #1489):
// GET /api/thoughts/search?project_id=X&include_global=true must widen a
// project-scoped search to also return global thoughts. Mirrors the mock/auth
// setup of thoughts-search.supersession.test.ts.

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	restartEmbedder: () => {},
	isEmbedderReady: () => true,
}));

process.env.SYNAPTOMIND_SECRET = "test-token";
const app = createApp();

async function request(path: string): Promise<Response> {
	const headers = new Headers();
	headers.set("Authorization", "Bearer test-token");
	return app.request(path, { headers });
}

interface SearchResultBody {
	thought: { id: string; content: string };
}

async function search(query: string): Promise<SearchResultBody[]> {
	const res = await request(`/api/thoughts/search?${query}`);
	expect(res.status).toBe(200);
	return (await res.json()) as SearchResultBody[];
}

beforeEach(createTestDb);
afterEach(closeDb);

const P1 = "http-global-p1";
const P2 = "http-global-p2";
const QUERY = "HTTP_GLOBAL_MARKER";

function seedWorld(): { local: string; foreign: string; global: string } {
	const local = seedThought({
		content: `${QUERY} local`,
		project_id: P1,
		status: "active",
	});
	const foreign = seedThought({
		content: `${QUERY} foreign`,
		project_id: P2,
		status: "active",
	});
	// Global thought owned by P2 — must surface in a P1-scoped search.
	const global = seedThought({
		content: `${QUERY} global`,
		project_id: P2,
		is_global: 1,
		status: "active",
	});
	return { local, foreign, global };
}

test("GET /api/thoughts/search?project_id&include_global=true includes global thoughts", async () => {
	const { local, foreign, global } = seedWorld();

	const results = await search(`q=${QUERY}&project_id=${P1}&include_global=true`);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(local);
	expect(ids).toContain(global);
	expect(ids).not.toContain(foreign);
});

test("GET /api/thoughts/search without include_global excludes global thoughts (backward compatible)", async () => {
	const { local, foreign, global } = seedWorld();

	const results = await search(`q=${QUERY}&project_id=${P1}`);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(local);
	expect(ids).not.toContain(global);
	expect(ids).not.toContain(foreign);
});

test("GET /api/thoughts/search?include_global=false excludes global thoughts", async () => {
	const { local, global } = seedWorld();

	const results = await search(
		`q=${QUERY}&project_id=${P1}&include_global=false`,
	);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(local);
	expect(ids).not.toContain(global);
});

test("GET /api/thoughts/search?include_global=true without project_id returns every project's thoughts", async () => {
	const { local, foreign, global } = seedWorld();

	const results = await search(`q=${QUERY}&include_global=true`);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(local);
	expect(ids).toContain(foreign);
	expect(ids).toContain(global);
});
