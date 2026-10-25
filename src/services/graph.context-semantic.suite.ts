import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
	drainPendingEmbeddings,
	isVecExtensionAvailable,
	seedThought,
	withVecDb,
} from "../test/helpers";
import { getContextService } from "./graph.service";
import { searchThoughts } from "./search.service";

const VECTOR = new Float32Array(384);
for (let i = 0; i < VECTOR.length; i++) VECTOR[i] = 0.25;

/**
 * The mocked query embedding. Tests that need a controlled cosine similarity
 * swap this (and restore {@link VECTOR}) instead of reaching a real embedder.
 */
let queryVector: Float32Array = VECTOR;

mock.module("../embedder/client", () => ({
	generateEmbedding: async () => queryVector,
	generateEmbeddings: async () => [queryVector],
	isEmbedderReady: () => true,
}));

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
	test.skipIf(!isVecExtensionAvailable())(name, () => withVecDb(fn));
}

/** A 384-d unit vector whose cosine similarity to `e0` is exactly `cos`. */
function vectorAtCos(cos: number): Float32Array {
	const v = new Float32Array(384);
	v[0] = cos;
	v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
	return v;
}

function insertVector(db: Database, thoughtId: string, vector: Float32Array): void {
	const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
	db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(
		thoughtId,
		buf,
	);
}

describe("getContextService uses real embeddings", () => {
	itVec("returns a semantically matched thought even when BM25 does not match", async (db) => {
		const id = seedThought({ content: "semantic context target thought" });
		drainPendingEmbeddings([id]);
		const buf = Buffer.from(VECTOR.buffer, VECTOR.byteOffset, VECTOR.byteLength);
		db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(id, buf);

		const ctx = await getContextService("zzzznomatchtoken", 3, undefined, db);

		expect(ctx).not.toBeNull();
		expect(ctx!.best_match!.id).toBe(id);
		expect(ctx!.degraded).toBe(false);
	});
});

/**
 * Task #2187: the relevance gate is opt-out on the context path.
 *
 * `context` asks for the single best match, so the default gate of the search
 * surface (cosine-only rows must reach 0.4 calibrated) would turn a weak but
 * real neighbourhood into "no match". The query below is `e0` rotated so its
 * cosine similarity to the seeded thought is 0.83 — calibrated relevance 0.3,
 * i.e. below the default 0.4 gate and therefore dropped by a plain search.
 */
describe("getContextService keeps the pre-gate best match (task #2187)", () => {
	const QUERY = "zzzzweakgatenolexicalmatch";

	async function seedWeakPair(db: Database): Promise<string> {
		const id = seedThought({ content: "WEAK_GATE context target" });
		drainPendingEmbeddings([id]);
		insertVector(db, id, vectorAtCos(1));
		return id;
	}

	itVec("returns the weak cosine-only best match that the default search gate drops", async (db) => {
		const id = await seedWeakPair(db);
		queryVector = vectorAtCos(0.83);
		try {
			// Positive contrast: the same pair really is below the search gate, so
			// this test cannot pass by accident when the gate starts applying.
			const gated = await searchThoughts(
				{ query: QUERY, topK: 5, statusFilter: "active" },
				db,
			);
			expect(gated).toEqual([]);

			const ctx = await getContextService(QUERY, 3);

			expect(ctx).not.toBeNull();
			expect(ctx!.best_match!.id).toBe(id);
			expect(ctx!.degraded).toBe(false);
		} finally {
			queryVector = VECTOR;
		}
	});

	itVec("an explicit min_relevance on a search call does not leak into context", async (db) => {
		const id = await seedWeakPair(db);
		queryVector = vectorAtCos(0.83);
		try {
			// A caller gating its own search as hard as possible...
			const gated = await searchThoughts(
				{ query: QUERY, topK: 5, statusFilter: "active", minRelevance: 1 },
				db,
			);
			expect(gated).toEqual([]);

			// ...must not affect the context lookup, which resolves its own gate.
			const ctx = await getContextService(QUERY, 3);

			expect(ctx).not.toBeNull();
			expect(ctx!.best_match!.id).toBe(id);
		} finally {
			queryVector = VECTOR;
		}
	});
});
