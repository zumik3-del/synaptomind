import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { closeDb } from "../db/init";
import { createTestDb, seedThought } from "../test/helpers";
import { searchThoughts } from "./search.service";
import { getContextService } from "./graph.service";

mock.module("../embedder/client", () => ({
	generateEmbedding: async () => {
		throw new Error("embedder down");
	},
	generateEmbeddings: async () => {
		throw new Error("embedder down");
	},
	isEmbedderReady: () => false,
}));

beforeEach(createTestDb);
afterEach(closeDb);

describe("search degraded path (embedder unavailable)", () => {
	test("searchThoughts reports degraded:true with BM25-only signals", async () => {
		seedThought({ content: "degraded search marker alpha" });

		const results = await searchThoughts({ query: "degraded search marker", topK: 5 });

		expect(Array.isArray(results)).toBeTrue();
		expect(results.length).toBeGreaterThan(0);
		expect((results as { degraded?: boolean }).degraded).toBe(true);
		for (const r of results) {
			expect(r.degraded).toBe(true);
			expect((r as { signals?: unknown }).signals).toBeUndefined();
		}
		expect((results as { signals?: unknown }).signals).toBeUndefined();
	});

	test("searchThoughts empty results still report degraded:true at top level", async () => {
		const results = await searchThoughts({ query: "no-such-term-zzz", topK: 5 });
		expect(Array.isArray(results)).toBeTrue();
		expect(results.length).toBe(0);
		expect((results as { degraded?: boolean }).degraded).toBe(true);
	});

	test("getContextService degraded path reports degraded:true", async () => {
		seedThought({ content: "degraded context marker beta" });

		const ctx = await getContextService("degraded context marker", { maxDegree: 3 });

		expect(ctx).not.toBeNull();
		expect(ctx!.degraded).toBe(true);
		expect((ctx as { signals?: unknown })!.signals).toBeUndefined();
	});

	test("getContextService degraded path (no matches) surfaces degraded without null", async () => {
		const ctx = await getContextService("zzzznomatchtoken-degraded", { maxDegree: 3 });

		expect(ctx).not.toBeNull();
		expect(ctx!.degraded).toBe(true);
		expect(ctx!.best_match).toBeUndefined();
		expect((ctx as { signals?: unknown })!.signals).toBeUndefined();
	});
});