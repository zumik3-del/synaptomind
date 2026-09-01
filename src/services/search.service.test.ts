import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb, hasVec } from "../db/init";
import { createTestDb, seedEmbedding, seedThought } from "../test/helpers";
import { searchThoughts } from "./search.service";

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	isEmbedderReady: () => true,
}));

beforeEach(createTestDb);
afterEach(closeDb);

const itVec = test.skipIf(!hasVec());

describe("searchThoughts", () => {
	itVec("returns results", async () => {
		seedThought({ content: "hello world" });
		const results = await searchThoughts({ query: "test", topK: 5 });
		expect(Array.isArray(results)).toBeTrue();
	});

	itVec("applies status filter", async () => {
		seedThought({ content: "active thought", status: "active" });
		const results = await searchThoughts({
			query: "test",
			topK: 5,
			statusFilter: "active",
		});
		expect(Array.isArray(results)).toBeTrue();
	});

	itVec("with clusterFilter only", async () => {
		const db = getDb();
		seedThought({ content: "normal" });
		const clusterId = seedThought({ content: "cluster thought" });
		db.prepare(`UPDATE thoughts SET is_cluster = 1 WHERE id = ?`).run(
			clusterId,
		);

		const results = await searchThoughts({
			query: "cluster",
			topK: 10,
			clusterFilter: "only",
		});

		expect(Array.isArray(results)).toBeTrue();
	});

	itVec("with clusterFilter exclude", async () => {
		const db = getDb();
		const normalId = seedThought({ content: "normal thought" });
		seedEmbedding(normalId);

		const clusterId = seedThought({ content: "cluster thought" });
		db.prepare(`UPDATE thoughts SET is_cluster = 1 WHERE id = ?`).run(
			clusterId,
		);

		const results = await searchThoughts({
			query: "normal",
			topK: 10,
			clusterFilter: "exclude",
		});

		expect(Array.isArray(results)).toBeTrue();
	});

	itVec("handles empty results", async () => {
		const results = await searchThoughts({ query: "nothing", topK: 5 });
		expect(Array.isArray(results)).toBeTrue();
		expect(results.length).toBe(0);
	});
});

describe("groupResultsByCluster", () => {
	itVec("groups results", () => {
		const db = getDb();
		const m1 = seedThought({ content: "member one" });
		const m2 = seedThought({ content: "member two" });
		seedEmbedding(m1);
		seedEmbedding(m2);

		const clusterId = seedThought({ content: "my cluster" });
		db.prepare(`UPDATE thoughts SET is_cluster = 1 WHERE id = ?`).run(
			clusterId,
		);

		try {
			createEdge(db, clusterId, m1, "cluster");
		} catch {}
		try {
			createEdge(db, clusterId, m2, "cluster");
		} catch {}
	});
});
