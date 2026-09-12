import { expect, test } from "bun:test";
import { pairKey } from "../db/utils";
import {
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
