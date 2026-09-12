import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { getDb } from "../db/container";
import { createEdge } from "../db/edges";
import { closeDb } from "../db/init";
import { createTestDb, seedThought } from "../test/helpers";
import { createApp } from "./router";

// Agent-facing retrieval contract (ADR #142, item 3): the HTTP search surface
// defaults to `suppress`, accepts the documented modes, and rejects unknown ones
// with a 400. Mirrors the mock/auth setup of routes.test.ts.

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
	standing?: string;
	superseded_by?: string[];
	contradicted_by?: string[];
}

async function search(query: string): Promise<SearchResultBody[]> {
	const res = await request(`/api/thoughts/search?${query}`);
	expect(res.status).toBe(200);
	return (await res.json()) as SearchResultBody[];
}

beforeEach(createTestDb);
afterEach(closeDb);

const QUERY = "supersessionroute";

function seedSupersededPair(): { oldThought: string; newThought: string } {
	const oldThought = seedThought({
		content: `${QUERY} older claim that is replaced`,
	});
	const newThought = seedThought({ content: `${QUERY} newer claim` });
	createEdge(getDb(), newThought, oldThought, "replaces");
	return { oldThought, newThought };
}

test("GET /api/thoughts/search defaults to suppress for superseded thoughts", async () => {
	const { oldThought, newThought } = seedSupersededPair();

	const results = await search(`q=${QUERY}`);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(newThought);
	expect(ids).not.toContain(oldThought);
	expect(results.find((r) => r.thought.id === newThought)?.standing).toBe(
		"current",
	);
});

test("GET /api/thoughts/search supersession_mode=suppress drops superseded rows", async () => {
	const { oldThought, newThought } = seedSupersededPair();

	const results = await search(`q=${QUERY}&supersession_mode=suppress`);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(newThought);
	expect(ids).not.toContain(oldThought);
});

test("GET /api/thoughts/search supersession_mode=flag annotates superseded rows", async () => {
	const { oldThought, newThought } = seedSupersededPair();

	const results = await search(`q=${QUERY}&supersession_mode=flag`);
	const old = results.find((r) => r.thought.id === oldThought);
	expect(old).toBeDefined();
	expect(old?.standing).toBe("superseded");
	expect(old?.superseded_by).toEqual([newThought]);
});

test("GET /api/thoughts/search supersession_mode=off stops flagging superseded rows", async () => {
	const { oldThought } = seedSupersededPair();

	// `off` is per-axis: contradiction stays on its `flag` default, so the row
	// still carries a combined `current` standing but no supersession data.
	const results = await search(`q=${QUERY}&supersession_mode=off`);
	const old = results.find((r) => r.thought.id === oldThought);
	expect(old).toBeDefined();
	expect(old?.standing).not.toBe("superseded");
	expect(old?.superseded_by).toBeUndefined();
});

test("GET /api/thoughts/search with both modes off returns fully unannotated rows", async () => {
	const { oldThought } = seedSupersededPair();

	const results = await search(
		`q=${QUERY}&supersession_mode=off&contradiction_mode=off`,
	);
	const old = results.find((r) => r.thought.id === oldThought);
	expect(old).toBeDefined();
	expect(old?.standing).toBeUndefined();
	expect(old?.superseded_by).toBeUndefined();
	expect(old?.contradicted_by).toBeUndefined();
});

test("GET /api/thoughts/search normalizes an empty supersession_mode to the default", async () => {
	const { oldThought, newThought } = seedSupersededPair();

	const results = await search(`q=${QUERY}&supersession_mode=`);
	const ids = results.map((r) => r.thought.id);
	expect(ids).toContain(newThought);
	expect(ids).not.toContain(oldThought);
});

test("GET /api/thoughts/search rejects an invalid supersession_mode with 400", async () => {
	const res = await request(`/api/thoughts/search?q=${QUERY}&supersession_mode=bogus`);
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error).toContain("invalid supersession_mode");
	expect(body.error).toContain("off|flag|suppress");
});

test("GET /api/thoughts/search rejects supersession_mode=suppressed as invalid", async () => {
	const res = await request(
		`/api/thoughts/search?q=${QUERY}&supersession_mode=suppressed`,
	);
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/search flags contradicted rows by default and never suppresses them", async () => {
	const a = seedThought({ content: `${QUERY} contradicted alpha` });
	const b = seedThought({ content: `${QUERY} contradicted beta` });
	createEdge(getDb(), a, b, "contradicts");

	const results = await search(`q=${QUERY}`);
	const aResult = results.find((r) => r.thought.id === a);
	const bResult = results.find((r) => r.thought.id === b);
	expect(aResult).toBeDefined();
	expect(bResult).toBeDefined();
	expect(aResult?.standing).toBe("contradicted");
	expect(aResult?.contradicted_by).toEqual([b]);
});

test("GET /api/thoughts/search contradiction_mode=off skips contradiction annotation", async () => {
	const a = seedThought({ content: `${QUERY} contradicted alpha` });
	const b = seedThought({ content: `${QUERY} contradicted beta` });
	createEdge(getDb(), a, b, "contradicts");

	const results = await search(`q=${QUERY}&contradiction_mode=off`);
	const aResult = results.find((r) => r.thought.id === a);
	expect(aResult).toBeDefined();
	expect(aResult?.standing).toBe("current");
	expect(aResult?.contradicted_by).toBeUndefined();
});

test("GET /api/thoughts/search rejects an invalid contradiction_mode with 400", async () => {
	const res = await request(
		`/api/thoughts/search?q=${QUERY}&contradiction_mode=suppress`,
	);
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error).toContain("invalid contradiction_mode");
	expect(body.error).toContain("off|flag");
});
