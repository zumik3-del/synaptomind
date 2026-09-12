import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import { pairKey } from "../db/utils";
import { createTestDb, seedEdge, seedThought } from "../test/helpers";
import {
	detectEdgeProposals,
	findDetectionCandidates,
	type EdgeDetectDeps,
	type NliClassifier,
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

function contradictionClassifier(score: number, entailment = 0.1): NliClassifier {
	return {
		classify: async () => ({
			entailment,
			contradiction: score,
			neutral: 1 - Math.max(score, entailment),
		}),
	};
}

describe("detectEdgeProposals", () => {
	test("emits an embedding-only contradicts proposal with full shape", async () => {
		const a = seedThought({ content: "the sky is blue" });
		const b = seedThought({ content: "the sky is green" });

		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, maxProposals: 10 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }),
			getDb(),
		);

		expect(result.degraded).toBe(false);
		expect(result.nli_enabled).toBe(false);
		expect(result.candidates).toBe(2);
		expect(result.pairs_evaluated).toBe(1);
		expect(result.proposals).toHaveLength(1);

		const proposal = result.proposals[0]!;
		expect(proposal.type).toBe("contradicts");
		expect(proposal.rationale).toBe("embedding_similarity_only");
		expect(proposal.confidence).toBeCloseTo(0.9, 5);
		expect(proposal.signals).toEqual({ embeddingSimilarity: 0.9 });
		expect(new Set([proposal.source_id, proposal.target_id])).toEqual(
			new Set([a, b]),
		);
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

	test("NLI gates low-confidence pairs out", async () => {
		const a = seedThought({ content: "alpha" });
		const b = seedThought({ content: "beta" });
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, nliThreshold: 0.8, supportThreshold: 0.8 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }, { nli: contradictionClassifier(0.5, 0.5) }),
			getDb(),
		);
		expect(result.nli_enabled).toBe(true);
		expect(result.proposals).toEqual([]);
		expect(result.pairs_evaluated).toBe(1);
	});

	test("NLI labels a contradiction and carries the nli signal", async () => {
		const a = seedThought({ content: "alpha" });
		const b = seedThought({ content: "beta" });
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, nliThreshold: 0.8 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }, { nli: contradictionClassifier(0.95) }),
			getDb(),
		);
		const proposal = result.proposals[0]!;
		expect(proposal.type).toBe("contradicts");
		expect(proposal.rationale).toBe("nli_contradiction");
		expect(proposal.confidence).toBeCloseTo(0.95, 5);
		expect(proposal.signals).toEqual({ embeddingSimilarity: 0.9, nliScore: 0.95 });
	});

	test("NLI directs supports from the entailing premise to the hypothesis", async () => {
		const a = seedThought({ content: "premise specific alpha" });
		const b = seedThought({ content: "hypothesis beta" });
		const nli: NliClassifier = {
			classify: async (premise) =>
				premise.includes("alpha")
					? { entailment: 0.9, contradiction: 0.05, neutral: 0.05 }
					: { entailment: 0.2, contradiction: 0.05, neutral: 0.75 },
		};
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, supportThreshold: 0.8, nliThreshold: 0.8 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }, { nli }),
			getDb(),
		);
		const proposal = result.proposals[0]!;
		expect(proposal.type).toBe("supports");
		expect(proposal.source_id).toBe(a);
		expect(proposal.target_id).toBe(b);
	});

	test("contradiction takes precedence over entailment for the same pair", async () => {
		const a = seedThought({ content: "alpha" });
		const b = seedThought({ content: "beta" });
		const result = await detectEdgeProposals(
			{ minSimilarity: 0.5, nliThreshold: 0.8, supportThreshold: 0.8 },
			deps({ [a]: [{ id: b, similarity: 0.9 }] }, { nli: contradictionClassifier(0.9, 0.9) }),
			getDb(),
		);
		expect(result.proposals[0]!.type).toBe("contradicts");
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
