import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import { pairKey } from "../db/utils";
import { createTestDb, drainPendingEmbeddings, seedEdge, seedThought, withVecDb } from "../test/helpers";
import * as searchDb from "../db/search";
import * as vectorSearchDb from "../db/search-vector";
import {
	detectEdgeProposals,
	findDetectionCandidates,
	type EdgeDetectDeps,
} from "./edge-detect.service";
import type { EmbeddingNeighbor } from "./edge-candidates.service";

beforeEach(createTestDb);
afterEach(closeDb);

const EMB = new Float32Array([1, 0, 0]);

function deps(
	neighbors: Record<string, EmbeddingNeighbor[]>,
	overrides: Partial<EdgeDetectDeps> = {},
): EdgeDetectDeps {
	return {
		embed: async (texts: string[]) => texts.map(() => EMB),
		searchNeighbors: (id) => neighbors[id] ?? [],
		...overrides,
	};
}

describe("detectEdgeProposals", () => {
	test("emits a similarity-only related proposal with full shape", async () => {
		const a = seedThought({ content: "the sky is blue" });
		const b = seedThought({ content: "the sky is green" });

		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, maxProposals: 10 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }),
			getDb(),
		);

		expect(result.degraded).toBe(false);
		expect(result.candidates).toBe(2);
		expect(result.pairs_evaluated).toBe(1);
		expect(result.proposals).toHaveLength(1);

		const proposal = result.proposals[0]!;
		expect(proposal.type).toBe("related");
		expect(proposal.rationale).toBe("embedding_similarity_only");
		expect(proposal.review_required).toBe(true);
		expect(proposal.confidence).toBeCloseTo(0.9, 5);
		expect(proposal.signals).toEqual({ embeddingSimilarity: 0.9 });
		expect(new Set([proposal.source_id, proposal.target_id])).toEqual(
			new Set([a, b]),
		);
	});

	test("every similarity-only proposal is a non-conflict related candidate", async () => {
		const ids = Array.from({ length: 3 }, (_, i) =>
			seedThought({ content: `candidate ${i}` }),
		);
		const neighbors: Record<string, EmbeddingNeighbor[]> = {};
		for (let i = 0; i < ids.length; i++) {
			neighbors[ids[i]!] = ids
				.filter((_, j) => j !== i)
				.map((id) => ({ id, similarity: 0.9 }));
		}
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, maxProposals: 10 },
			deps(neighbors),
			getDb(),
		);
		expect(result.proposals.length).toBeGreaterThan(0);
		for (const proposal of result.proposals) {
			expect(proposal.type).toBe("related");
			expect(proposal.review_required).toBe(true);
			expect(proposal.rationale).toBe("embedding_similarity_only");
		}
	});

	test("drops pairs below minSimilarity (recall filter)", async () => {
		const a = seedThought({ content: "alpha" });
		const b = seedThought({ content: "beta" });
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.8, maxProposals: 10 },
			deps({ [a]: [{ id: b, similarity: 0.79 }] }),
			getDb(),
		);
		expect(result.proposals).toEqual([]);
		expect(result.pairs_evaluated).toBe(0);
	});

	test("excludes pairs that already carry any edge", async () => {
		const a = seedThought({ content: "alpha" });
		const b = seedThought({ content: "beta" });
		createEdge(getDb(), a, b, "related");
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, maxProposals: 10 },
			deps({ [a]: [{ id: b, similarity: 0.99 }] }),
			getDb(),
		);
		expect(result.proposals).toEqual([]);
	});

	test("never writes an edge (proposals only)", async () => {
		const a = seedThought({ content: "alpha" });
		const b = seedThought({ content: "beta" });
		const db = getDb();
		const before = (db.prepare(`SELECT COUNT(*) AS cnt FROM edges`).get() as { cnt: number }).cnt;
		await detectEdgeProposals(
			{ minSimilarity: 0.5, maxProposals: 10 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }),
			db,
		);
		const after = (db.prepare(`SELECT COUNT(*) AS cnt FROM edges`).get() as { cnt: number }).cnt;
		expect(after).toBe(before);
	});

	test("caps proposals at maxProposals", async () => {
		const ids = Array.from({ length: 4 }, (_, i) =>
			seedThought({ content: `candidate ${i}` }),
		);
		const neighbors: Record<string, EmbeddingNeighbor[]> = {};
		for (let i = 0; i < ids.length; i++) {
			neighbors[ids[i]!] = ids
				.filter((_, j) => j !== i)
				.map((id) => ({ id, similarity: 0.9 }));
		}
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, maxProposals: 2 },
			deps(neighbors),
			getDb(),
		);
		expect(result.proposals).toHaveLength(2);
	});

	test("returns early without embedding when fewer than two candidates", async () => {
		seedThought({ content: "only one active thought" });
		let embedded = false;
		const result = await detectEdgeProposals(
			{},
			deps({}, { embed: async () => { embedded = true; return [EMB]; } }),
			getDb(),
		);
		expect(result.candidates).toBe(1);
		expect(result.degraded).toBe(false);
		expect(result.proposals).toEqual([]);
		expect(embedded).toBe(false);
	});

	test("degrades to no proposals when embedding throws", async () => {
		seedThought({ content: "alpha" });
		seedThought({ content: "beta" });
		const result = await detectEdgeProposals(
			{},
			deps({}, { embed: async () => { throw new Error("embedder unavailable"); } }),
			getDb(),
		);
		expect(result.degraded).toBe(true);
		expect(result.proposals).toEqual([]);
		expect(result.candidates).toBe(2);
	});

	test("degrades when the embedder returns the wrong number of vectors", async () => {
		seedThought({ content: "alpha" });
		seedThought({ content: "beta" });
		const result = await detectEdgeProposals(
			{},
			deps({}, { embed: async () => [EMB] }),
			getDb(),
		);
		expect(result.degraded).toBe(true);
		expect(result.proposals).toEqual([]);
	});

	test("project scope keeps detection local", async () => {
		const px = seedThought({ content: "project x claim", project_id: "proj-x" });
		const py = seedThought({ content: "project y claim", project_id: "proj-y" });
		const result = await detectEdgeProposals(
			{ projectId: "proj-x", minSimilarity: 0.5 },
			deps({ [px]: [{ id: py, similarity: 0.99 }] }),
			getDb(),
		);
		expect(result.candidates).toBe(1);
		expect(result.proposals).toEqual([]);
	});
});

describe("findDetectionCandidates", () => {
	test("keeps active non-cluster, non-member thoughts only", () => {
		const db = getDb();
		const active = seedThought({ content: "active regular" });
		const active2 = seedThought({ content: "active regular two" });
		seedThought({ content: "draft regular", status: "draft" });
		const cluster = seedThought({ content: "a cluster", is_cluster: 1 });
		const member = seedThought({ content: "cluster member" });
		seedEdge(cluster, member, "cluster");

		const ids = findDetectionCandidates(db, undefined, 100).map((c) => c.id);
		expect(ids).toContain(active);
		expect(ids).toContain(active2);
		expect(ids).not.toContain(cluster);
		expect(ids).not.toContain(member);
	});

	test("scopes candidates to a project", () => {
		const db = getDb();
		const x = seedThought({ content: "project x claim", project_id: "proj-x" });
		const y = seedThought({ content: "project y claim", project_id: "proj-y" });
		const ids = findDetectionCandidates(db, "proj-x", 100).map((c) => c.id);
		expect(ids).toContain(x);
		expect(ids).not.toContain(y);
	});

	test("bounds the result limit", () => {
		seedThought({ content: "one" });
		seedThought({ content: "two" });
		seedThought({ content: "three" });
		expect(findDetectionCandidates(getDb(), undefined, 2)).toHaveLength(2);
	});
});

// Keep the pairKey import meaningful: detection dedupes by canonical pair.
test("pairKey canonicalises direction for exclusion checks", () => {
	expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
});

// ── Stored-vector path: no re-embedding, in-memory neighbours (task #1566) ────

/** Store one 384-dim vector (vec_thoughts is `FLOAT[384]`). */
function vec384(angle: number): Float32Array {
	const v = new Float32Array(384);
	v[0] = Math.cos(angle);
	v[1] = Math.sin(angle);
	return v;
}

/**
 * Store one vector and drain the candidate's queued re-embed — the state after
 * the worker refreshed it. A row left in `pending_embeddings` is embedded live
 * instead (task #1569, R1).
 */
function storeVec(id: string, vector: Float32Array): void {
	getDb()
		.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
		.run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength));
	drainPendingEmbeddings([id]);
}

describe("stored embeddings", () => {
	test("makes 0 embedder calls when every candidate already has a vector", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			const b = seedThought({ content: "beta" });
			storeVec(a, vec384(0));
			storeVec(b, vec384(Math.acos(0.9)));
			let embedCalls = 0;

			const result = await detectEdgeProposals(
				{ minSimilarity: 0.5, maxProposals: 10 },
				{
					embed: async texts => {
						embedCalls++;
						return texts.map(() => vec384(0));
					},
				},
			);

			expect(embedCalls).toBe(0);
			expect(result.degraded).toBe(false);
			expect(result.candidates).toBe(2);
			expect(result.proposals).toHaveLength(1);
			expect(result.proposals[0]!.confidence).toBeCloseTo(0.9, 4);
		});
	});

	test("embeds only the candidates missing a vector, in candidate order", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			const b = seedThought({ content: "beta" });
			seedThought({ content: "gamma" });
			storeVec(a, vec384(0));
			storeVec(b, vec384(Math.acos(0.9)));
			const seen: string[][] = [];

			const result = await detectEdgeProposals(
				{ minSimilarity: 0.5, maxProposals: 10 },
				{
					embed: async texts => {
						seen.push(texts);
						return texts.map(() => vec384(0));
					},
				},
			);

			expect(seen).toEqual([["gamma"]]);
			expect(result.degraded).toBe(false);
			expect(result.candidates).toBe(3);
		});
	});

	test("still degrades when the embedder returns the wrong number of vectors", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			seedThought({ content: "beta" });
			storeVec(a, vec384(0));

			const result = await detectEdgeProposals(
				{ minSimilarity: 0.5 },
				{ embed: async () => [] },
			);

			expect(result.degraded).toBe(true);
			expect(result.proposals).toEqual([]);
		});
	});

	test("default path issues no per-candidate vec0 search", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			const b = seedThought({ content: "beta" });
			storeVec(a, vec384(0));
			storeVec(b, vec384(Math.acos(0.9)));

			const searchSpy = spyOn(searchDb, "searchThoughts");
			const result = await detectEdgeProposals({ minSimilarity: 0.5, maxProposals: 10 });

			expect(searchSpy.mock.calls.length).toBe(0);
			expect(result.proposals).toHaveLength(1);
			searchSpy.mockRestore();
		});
	});
});

// ── Coverage, threshold convention, DI seam (task #1567) ─────────────────────

describe("stored-vector regression pins (task #1567)", () => {
	test("the generated vector joins the stored ones so every candidate is covered", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			const b = seedThought({ content: "beta" });
			const c = seedThought({ content: "gamma" });
			storeVec(a, vec384(0));
			storeVec(b, vec384(Math.acos(0.92)));
			const seen: string[][] = [];

			const result = await detectEdgeProposals(
				{ minSimilarity: 0.5, maxProposals: 10 },
				{
					embed: async (texts) => {
						seen.push(texts);
						// `gamma` is embedded at beta's angle: it pairs with both
						// stored candidates, so all three must appear in the output.
						return texts.map(() => vec384(Math.acos(0.92)));
					},
				},
			);

			expect(seen).toEqual([["gamma"]]);
			expect(result.candidates).toBe(3);
			expect(
				new Set(result.proposals.map((p) => pairKey(p.source_id, p.target_id))),
			).toEqual(new Set([pairKey(a, b), pairKey(a, c), pairKey(b, c)]));
		});
	});

	test("minSimilarity is a SIMILARITY threshold, not a distance one", async () => {
		await withVecDb(async () => {
			const x = seedThought({ content: "xray" });
			const y = seedThought({ content: "yankee" });
			const z = seedThought({ content: "zulu" });
			// cos(X,Y) = 0.10 (distance 0.90) and cos(X,Z) = 0.92 (distance 0.08):
			// the pairs straddle the 0.09 threshold symmetrically, so reading a
			// distance as a similarity drops the 0.92-similarity pair.
			storeVec(x, vec384(0));
			storeVec(y, vec384(Math.acos(0.1)));
			storeVec(z, vec384(-Math.acos(0.92)));

			const result = await detectEdgeProposals({ minSimilarity: 0.09, maxProposals: 10 });

			expect(
				new Set(result.proposals.map((p) => pairKey(p.source_id, p.target_id))),
			).toEqual(new Set([pairKey(x, y), pairKey(x, z)]));
			// Y-Z is at cosine -0.30: below the threshold on both conventions.
			expect(result.proposals).toHaveLength(2);
		});
	});

	test("an injected searchNeighbors overrides the in-memory default", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			const b = seedThought({ content: "beta" });
			// Orthogonal vectors: the in-memory lookup reports ~0 similarity and
			// emits nothing, so a proposal can only come from the injected lookup.
			storeVec(a, vec384(0));
			storeVec(b, vec384(Math.PI / 2));

			const plain = await detectEdgeProposals({ minSimilarity: 0.09, maxProposals: 10 });
			expect(plain.proposals).toEqual([]);

			let calls = 0;
			const injected = (id: string): EmbeddingNeighbor[] => {
				calls++;
				return [{ id: id === a ? b : a, similarity: 0.99 }];
			};
			const overridden = await detectEdgeProposals(
				{ minSimilarity: 0.09, maxProposals: 10 },
				{ searchNeighbors: injected },
			);

			expect(calls).toBe(2);
			expect(overridden.proposals).toHaveLength(1);
			expect(overridden.proposals[0]!.confidence).toBeCloseTo(0.99, 5);
		});
	});

	test("the default path runs no vec0 neighbour query (spy + positive control)", async () => {
		await withVecDb(async () => {
			const a = seedThought({ content: "alpha" });
			const b = seedThought({ content: "beta" });
			storeVec(a, vec384(0));
			storeVec(b, vec384(Math.acos(0.9)));

			const vectorSpy = spyOn(vectorSearchDb, "vecSearchIds");
			try {
				const result = await detectEdgeProposals({ minSimilarity: 0.5, maxProposals: 10 });
				expect(result.proposals).toHaveLength(1);
				const afterRun = vectorSpy.mock.calls.length;

				// Positive control: the spy does observe this query path, so a
				// count of 0 during the service run is evidence, not a dead spy.
				searchDb.searchThoughts(getDb(), { embedding: vec384(0), topK: 1 });
				expect(vectorSpy.mock.calls.length).toBeGreaterThan(afterRun);
				expect(afterRun).toBe(0);
			} finally {
				vectorSpy.mockRestore();
			}
		});
	});

	test("without vec_thoughts the in-memory path still proposes pairs (:memory:)", async () => {
		createTestDb();
		seedThought({ content: "alpha" });
		seedThought({ content: "beta" });

		// Pre-change this run produced no proposals: every neighbour query threw
		// (no vec_thoughts) and the per-candidate catch returned []. The batch
		// read now degrades to "no stored vectors" and compares in memory.
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.09, maxProposals: 10 },
			{ embed: async (texts) => texts.map(() => vec384(0)) },
		);

		expect(result.degraded).toBe(false);
		expect(result.candidates).toBe(2);
		expect(result.proposals).toHaveLength(1);
	});
});
