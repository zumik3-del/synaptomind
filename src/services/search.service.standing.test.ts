import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import { createTestDb, seedThought } from "../test/helpers";
import { searchThoughts } from "./search.service";

// The search service only needs *an* embedding to pass to the DB layer; graph
// standing is computed from edges. A fixed zero vector keeps BM25 as the
// effective leg here (vec0 is absent from :memory:).
mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	isEmbedderReady: () => true,
}));

beforeEach(createTestDb);
afterEach(closeDb);

const QUERY = "standing";

function byId(results: Awaited<ReturnType<typeof searchThoughts>>, id: string) {
	return results.find((r) => r.thought.id === id);
}

describe("searchThoughts graph standing (ADR #142 D2)", () => {
	test("flags a superseded result by default", async () => {
		const oldThought = seedThought({ content: "standing old claim" });
		const newThought = seedThought({ content: "standing new claim" });
		createEdge(getDb(), newThought, oldThought, "replaces");

		const results = await searchThoughts({ query: QUERY, topK: 10 });

		const oldResult = byId(results, oldThought);
		expect(oldResult).toBeDefined();
		expect(oldResult!.standing).toBe("superseded");
		expect(oldResult!.superseded_by).toEqual([newThought]);
		expect(byId(results, newThought)!.standing).toBe("current");
	});

	test("suppress drops superseded rows, flag keeps them", async () => {
		const oldThought = seedThought({ content: "standing old claim" });
		const newThought = seedThought({ content: "standing new claim" });
		createEdge(getDb(), newThought, oldThought, "replaces");

		const suppressed = await searchThoughts({
			query: QUERY,
			topK: 10,
			supersessionMode: "suppress",
		});
		expect(byId(suppressed, oldThought)).toBeUndefined();
		expect(byId(suppressed, newThought)).toBeDefined();

		const flagged = await searchThoughts({
			query: QUERY,
			topK: 10,
			supersessionMode: "flag",
		});
		expect(byId(flagged, oldThought)?.standing).toBe("superseded");
	});

	test("contradicted results are flagged and never suppressed", async () => {
		const a = seedThought({ content: "standing claim alpha" });
		const b = seedThought({ content: "standing claim beta" });
		createEdge(getDb(), a, b, "contradicts");

		// `suppress` must not hide a contradicted endpoint: neither side is
		// authoritative, so both stay visible for the agent to resolve.
		const results = await searchThoughts({
			query: QUERY,
			topK: 10,
			supersessionMode: "suppress",
		});

		const aResult = byId(results, a);
		const bResult = byId(results, b);
		expect(aResult).toBeDefined();
		expect(bResult).toBeDefined();
		expect(aResult!.standing).toBe("contradicted");
		expect(aResult!.contradicted_by).toEqual([b]);
		expect(bResult!.contradicted_by).toEqual([a]);
	});

	test("off modes leave results unannotated", async () => {
		const a = seedThought({ content: "standing claim a" });
		const b = seedThought({ content: "standing claim b" });
		createEdge(getDb(), a, b, "contradicts");

		const results = await searchThoughts({
			query: QUERY,
			topK: 10,
			supersessionMode: "off",
			contradictionMode: "off",
		});
		expect(byId(results, a)?.standing).toBeUndefined();
		expect(byId(results, a)?.contradicted_by).toBeUndefined();
	});

	test("contradictionMode off skips contradiction annotation only", async () => {
		const oldThought = seedThought({ content: "standing old claim" });
		const newThought = seedThought({ content: "standing new claim" });
		const rival = seedThought({ content: "standing rival claim" });
		createEdge(getDb(), newThought, oldThought, "replaces");
		createEdge(getDb(), oldThought, rival, "contradicts");

		const results = await searchThoughts({
			query: QUERY,
			topK: 10,
			contradictionMode: "off",
		});
		const oldResult = byId(results, oldThought)!;
		expect(oldResult.standing).toBe("superseded");
		expect(oldResult.superseded_by).toEqual([newThought]);
		expect(oldResult.contradicted_by).toBeUndefined();
	});
});
