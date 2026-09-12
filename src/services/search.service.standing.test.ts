import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import { bm25SearchIds, type SearchResult } from "../db/search";
import type { GraphStanding } from "../db/graph-annotations";
import { createTestDb, seedThought } from "../test/helpers";
import { orderByStanding, searchThoughts } from "./search.service";

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

	test("suppress over-fetches to backfill topK when superseded rows rank first", async () => {
		// Six superseded rows whose keyword relevance outranks their current
		// replacements, all ahead of the current rows in the raw (BM25) order.
		// A non-widening pool would fetch topK superseded rows, drop them all and
		// return an empty/short list.
		const query = "suppressionbackfill";
		const oldIds: string[] = [];
		const newIds: string[] = [];
		for (let i = 0; i < 6; i++) {
			const oldId = seedThought({
				content: `${query} ${query} ${query} ${query} ${query} legacy ${i}`,
			});
			const newId = seedThought({ content: `${query} current ${i}` });
			createEdge(getDb(), newId, oldId, "replaces");
			oldIds.push(oldId);
			newIds.push(newId);
		}

		const raw = bm25SearchIds(getDb(), query, 30);
		const firstCurrent = raw.findIndex((id) => newIds.includes(id));
		const lastSuperseded = raw.findLastIndex((id) => oldIds.includes(id));
		expect(lastSuperseded).toBeGreaterThanOrEqual(0);
		expect(lastSuperseded).toBeLessThan(firstCurrent);

		const results = await searchThoughts({
			query,
			topK: 3,
			supersessionMode: "suppress",
		});
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.standing === "current")).toBe(true);
		expect(results.every((r) => newIds.includes(r.thought.id))).toBe(true);
	});

	test("flag mode orders current rows before equal-similarity superseded rows", async () => {
		const query = "standingorder";
		const oldThought = seedThought({
			content: `${query} ${query} ${query} ${query} legacy`,
		});
		const newThought = seedThought({ content: `${query} current` });
		createEdge(getDb(), newThought, oldThought, "replaces");

		// The relevance leg alone would put the superseded row first.
		const raw = bm25SearchIds(getDb(), query, 10);
		expect(raw.indexOf(oldThought)).toBeLessThan(raw.indexOf(newThought));

		const results = await searchThoughts({
			query,
			topK: 10,
			supersessionMode: "flag",
		});
		const oldIndex = results.findIndex((r) => r.thought.id === oldThought);
		const newIndex = results.findIndex((r) => r.thought.id === newThought);
		expect(newIndex).toBeGreaterThanOrEqual(0);
		expect(oldIndex).toBeGreaterThan(newIndex);
		expect(results[oldIndex].standing).toBe("superseded");
	});

	test("standing rank orders current then contradicted then superseded on ties", async () => {
		const query = "standingrank";
		const contested = seedThought({ content: `${query} alpha` });
		const rival = seedThought({ content: `${query} beta` });
		const superseded = seedThought({ content: `${query} gamma` });
		const replacement = seedThought({ content: `${query} delta` });
		createEdge(getDb(), contested, rival, "contradicts");
		createEdge(getDb(), replacement, superseded, "replaces");

		const results = await searchThoughts({
			query,
			topK: 10,
			supersessionMode: "flag",
		});
		const order = results.map((r) => r.thought.id);
		expect(byId(results, contested)!.standing).toBe("contradicted");
		expect(byId(results, rival)!.standing).toBe("contradicted");
		expect(order.indexOf(contested)).toBeLessThan(order.indexOf(superseded));
		expect(order.indexOf(rival)).toBeLessThan(order.indexOf(superseded));
		expect(order.indexOf(superseded)).toBeGreaterThanOrEqual(0);
	});

	test("multiple replaces sources are all reported for one target", async () => {
		const oldThought = seedThought({ content: "standingmulti old target" });
		const newA = seedThought({ content: "standingmulti replacement a" });
		const newB = seedThought({ content: "standingmulti replacement b" });
		createEdge(getDb(), newA, oldThought, "replaces");
		createEdge(getDb(), newB, oldThought, "replaces");

		const results = await searchThoughts({
			query: "standingmulti",
			topK: 10,
			supersessionMode: "flag",
		});
		const oldResult = byId(results, oldThought)!;
		expect(oldResult.standing).toBe("superseded");
		expect([...oldResult.superseded_by!].sort()).toEqual([newA, newB].sort());
	});

	test("a thought both superseded and contradicted reports both and is still suppressed", async () => {
		const oldThought = seedThought({ content: "standingboth old target" });
		const replacement = seedThought({
			content: "standingboth replacement",
		});
		const rival = seedThought({ content: "standingboth rival" });
		createEdge(getDb(), replacement, oldThought, "replaces");
		createEdge(getDb(), oldThought, rival, "contradicts");

		// Superseded wins the tie for suppression: the stale claim is dropped even
		// though it is also contradicted. The contradicted-only rival stays.
		const suppressed = await searchThoughts({
			query: "standingboth",
			topK: 10,
			supersessionMode: "suppress",
		});
		expect(byId(suppressed, oldThought)).toBeUndefined();
		expect(byId(suppressed, rival)).toBeDefined();

		const flagged = await searchThoughts({
			query: "standingboth",
			topK: 10,
			supersessionMode: "flag",
		});
		const oldResult = byId(flagged, oldThought)!;
		expect(oldResult.standing).toBe("superseded");
		expect(oldResult.superseded_by).toEqual([replacement]);
		expect(oldResult.contradicted_by).toEqual([rival]);
	});

	test("suppress with an empty candidate pool returns []", async () => {
		seedThought({ content: "unrelated content" });
		const results = await searchThoughts({
			query: "zzznomatchzzz",
			topK: 5,
			supersessionMode: "suppress",
		});
		expect(results).toEqual([]);
	});
});

// Regression guard: standing ordering must not be driven by `similarity`.
// `similarity` is populated from the vector leg only, so BM25/entity-only hits
// carry 0 and a similarity-primary sort would sink them below every vector hit.
describe("orderByStanding (ADR #142 item 3)", () => {
	function stubResult(
		id: string,
		similarity: number,
		standing: GraphStanding,
	): SearchResult {
		return {
			thought: {
				id,
				created_at: "2024-01-01T00:00:00.000Z",
				updated_at: "2024-01-01T00:00:00.000Z",
			} as SearchResult["thought"],
			distance: 1 - similarity,
			similarity,
			standing,
		};
	}

	test("partitions by standing without using the raw vector similarity", () => {
		const ordered = orderByStanding([
			stubResult("superseded-high", 0.9, "superseded"),
			stubResult("current-low", 0, "current"),
			stubResult("contradicted", 0, "contradicted"),
			stubResult("current-high", 0.8, "current"),
		]).map((r) => r.thought.id);

		expect(ordered).toEqual([
			"current-low",
			"current-high",
			"contradicted",
			"superseded-high",
		]);
	});

	test("preserves the incoming relevance order within one standing", () => {
		const ordered = orderByStanding([
			stubResult("a", 0.1, "current"),
			stubResult("b", 0.9, "current"),
			stubResult("c", 0.5, "current"),
		]).map((r) => r.thought.id);

		expect(ordered).toEqual(["a", "b", "c"]);
	});
});
