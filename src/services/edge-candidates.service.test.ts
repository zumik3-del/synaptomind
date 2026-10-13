import { expect, test } from "bun:test";
import { pairKey } from "../db/utils";
import {
	buildInMemoryDistanceLookup,
	buildInMemoryNeighborLookup,
	findEmbeddingNeighborPairs,
	type EmbeddingNeighbor,
	type SearchNeighborsFn,
} from "./edge-candidates.service";

const EMB = new Float32Array([1, 0, 0]);

function stubSearch(map: Record<string, EmbeddingNeighbor[]>): SearchNeighborsFn {
	return (id) => map[id] ?? [];
}

function pairSet(pairs: Array<{ source_id: string; target_id: string }>): Set<string> {
	return new Set(pairs.map((p) => pairKey(p.source_id, p.target_id)));
}

test("builds one deduplicated pair, keeping the highest similarity", () => {
	const candidates = [{ id: "a" }, { id: "b" }];
	const pairs = findEmbeddingNeighborPairs(
		candidates,
		[EMB, EMB],
		0.5,
		stubSearch({
			a: [{ id: "b", similarity: 0.8 }],
			b: [{ id: "a", similarity: 0.95 }],
		}),
	);
	expect(pairs).toHaveLength(1);
	expect(pairs[0]!.embeddingSimilarity).toBeCloseTo(0.95, 5);
	expect(pairSet(pairs)).toEqual(new Set([pairKey("a", "b")]));
});

test("skips self hits, non-candidate neighbours, and sub-threshold similarity", () => {
	const candidates = [{ id: "a" }, { id: "b" }];
	const pairs = findEmbeddingNeighborPairs(
		candidates,
		[EMB, EMB],
		0.7,
		stubSearch({
			a: [
				{ id: "a", similarity: 1 }, // self
				{ id: "outsider", similarity: 1 }, // not a candidate
				{ id: "b", similarity: 0.69 }, // below threshold
			],
			b: [{ id: "outsider", similarity: 1 }],
		}),
	);
	expect(pairs).toEqual([]);
});

test("swallows neighbour-search errors and keeps processing other candidates", () => {
	const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
	const pairs = findEmbeddingNeighborPairs(
		candidates,
		[EMB, EMB, EMB],
		0.5,
		(id) => {
			if (id === "a") throw new Error("index down");
			if (id === "b") return [{ id: "c", similarity: 0.9 }];
			return [];
		},
	);
	expect(pairSet(pairs)).toEqual(new Set([pairKey("b", "c")]));
});

test("skips candidates without a corresponding embedding", () => {
	const candidates = [{ id: "a" }, { id: "b" }];
	const pairs = findEmbeddingNeighborPairs(
		candidates,
		[undefined as unknown as Float32Array, EMB],
		0.5,
		// `a` has a high-similarity hit but no embedding → its lookup never runs
		stubSearch({ a: [{ id: "b", similarity: 0.9 }] }),
	);
	expect(pairs).toEqual([]);
});

test("respects topK passed through to the neighbour lookup", () => {
	const candidates = [{ id: "a" }, { id: "b" }];
	const seenK: number[] = [];
	findEmbeddingNeighborPairs(
		candidates,
		[EMB, EMB],
		0.5,
		(_id, _emb, k) => {
			seenK.push(k);
			return [];
		},
		7,
	);
	expect(seenK).toEqual([7, 7]);
});

// ── In-memory neighbour lookup (task #1566) ───────────────────────────────────

/** Assert `actual` and `expected` hold the same scored neighbours in the same order. */
function expectSameNeighbors(
	actual: EmbeddingNeighbor[],
	expected: Array<{ id: string; similarity: number }>
): void {
	expect(actual.map(n => n.id)).toEqual(expected.map(n => n.id))
	actual.forEach((n, i) => {
		expect(n.similarity).toBeCloseTo(expected[i]!.similarity, 5)
	})
}

/** Unit vector in the `[cos, sin]` plane, so pairwise cosines are exact. */
function unitAt(angle: number): Float32Array {
	const v = new Float32Array(384)
	v[0] = Math.cos(angle)
	v[1] = Math.sin(angle)
	return v
}

test("similarity lookup reproduces the vec0 lookup's neighbour sets for known cosines", () => {
	const candidates = [
		{ id: "A", content: "A" },
		{ id: "B", content: "B" },
		{ id: "C", content: "C" },
		{ id: "D", content: "D" },
	];
	// cosines A-B 0.95 / A-C 0.59 / A-D 0.1 — the same matrix a vec0 lookup returns.
	const embeddings = [unitAt(0), unitAt(Math.acos(0.95)), unitAt(Math.acos(0.59)), unitAt(Math.acos(0.1))];
	const lookup = buildInMemoryNeighborLookup(candidates, embeddings);

	expectSameNeighbors(lookup("A", embeddings[0]!, 3), [
		{ id: "B", similarity: 0.95 },
		{ id: "C", similarity: 0.59 },
		{ id: "D", similarity: 0.1 },
	]);
	expectSameNeighbors(lookup("B", embeddings[1]!, 3), [
		{ id: "A", similarity: 0.95 },
		{ id: "C", similarity: Math.cos(Math.acos(0.95) - Math.acos(0.59)) },
		{ id: "D", similarity: Math.cos(Math.acos(0.95) - Math.acos(0.1)) },
	]);
	// topK caps the returned neighbours; the searchThoughts path clamped the pool the same way.
	expect(lookup("A", embeddings[0]!, 2).map(n => n.id)).toEqual(["B", "C"]);
});

test('distance lookup reports `1 - similarity` for the auto-cluster convention', () => {
	const candidates = [
		{ id: "A", content: "A" },
		{ id: "B", content: "B" },
		{ id: "C", content: "C" },
	];
	const embeddings = [unitAt(0), unitAt(Math.acos(0.75)), unitAt(Math.acos(0.25))];
	const lookup = buildInMemoryDistanceLookup(candidates, embeddings);

	// `topK` caps the returned neighbours, exactly as the injected
	// `searchNeighbors` it defaults for.
	const neighbors = lookup("A", 2);
	expect(neighbors.map(n => n.id)).toEqual(["B", "C"]);
	expect(neighbors[0]!.distance).toBeCloseTo(0.25, 5);
	expect(neighbors[1]!.distance).toBeCloseTo(0.75, 5);
});

test('lookups guard zero-norm vectors and rank the unknown id as no neighbours', () => {
	const zero = new Float32Array(384);
	const unit = unitAt(0);
	const candidates = [
		{ id: "zero", content: "zero" },
		{ id: "unit", content: "unit" },
	];
	// A zero-norm row cannot produce a cosine: it is reported as similarity 0
	// (distance 1) instead of NaN, which would poison every comparison downstream.
	expect(buildInMemoryNeighborLookup(candidates, [zero, unit])("zero", zero, 5)).toEqual([
		{ id: "unit", similarity: 0 },
	]);
	expect(buildInMemoryDistanceLookup(candidates, [zero, unit])("zero", 5)).toEqual([
		{ id: "unit", distance: 1 },
	]);
	expect(buildInMemoryNeighborLookup(candidates, [zero, unit])("not-a-candidate", zero, 5)).toEqual([]);
	expect(buildInMemoryDistanceLookup(candidates, [zero, unit])("not-a-candidate", 5)).toEqual([]);
});

test('lookup uses the caller-supplied `thoughtId` rather than the passed embedding', () => {
	const candidates = [
		{ id: "A", content: "A" },
		{ id: "B", content: "B" },
	];
	const embeddings = [unitAt(0), unitAt(Math.acos(0.9))];
	const lookup = buildInMemoryNeighborLookup(candidates, embeddings);
	// A mismatched embedding argument must not change the answer: the lookup
	// identifies the query row by id, exactly like the index it replaces.
	expectSameNeighbors(lookup("A", new Float32Array(384), 5), [{ id: "B", similarity: 0.9 }])
})
