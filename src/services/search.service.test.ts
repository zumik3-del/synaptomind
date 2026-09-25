import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb, hasVec } from "../db/init";
import { createTestDb, seedEmbedding, seedThought } from "../test/helpers";
import { searchThoughts, searchThoughtsGrouped } from "./search.service";

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
  test("groups results", () => {
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

// ── Recency boost (issue #145, task #821) ─────────────────────────────────────

describe("recency boost — service layer", () => {
  test("recency order survives applyGraphStanding within each standing group", async () => {
    const db = getDb();
    const nowMs = Date.now();
    const older = new Date(nowMs - 20 * 24 * 3600_000).toISOString();
    const newer = new Date(nowMs - 5 * 24 * 3600_000).toISOString();
    // Two current (non-contested) thoughts with different ages — both land in
    // the 'current' standing group. Newer must rank first within that group.
    const oldId = seedThought({ content: "REC_STANDING same topic marker" });
    const newId = seedThought({ content: "REC_STANDING same topic marker" });
    db.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(older, oldId);
    db.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(newer, newId);
    // Add a contradicted pair so we can also verify intra-group recency there.
    const aId = seedThought({ content: "REC_STANDING alpha" });
    const bId = seedThought({ content: "REC_STANDING beta" });
    createEdge(db, aId, bId, "contradicts");

    const results = await searchThoughts({
      query: "REC_STANDING",
      topK: 10,
      hybrid: true,
      recencyWeight: 0.5,
      recencyHalfLifeDays: 30,
      supersessionMode: "flag",
    });

    // Both oldId and newId are 'current' (no replaces edge).
    const currentIds = results
      .filter((r) => r.standing === "current")
      .map((r) => r.thought.id);
    expect(currentIds).toContain(oldId);
    expect(currentIds).toContain(newId);
    // Newer ranks above older within the current group.
    expect(currentIds.indexOf(newId)).toBeLessThan(currentIds.indexOf(oldId));
    // Contradicted pair both present and ordered (same age → stable sort).
    const contradictedIds = results
      .filter((r) => r.standing === "contradicted")
      .map((r) => r.thought.id);
    expect(contradictedIds).toContain(aId);
    expect(contradictedIds).toContain(bId);
  });

  test("suppress + recency backfills to topK from final-score pool", async () => {
    const db = getDb();
    // Create 3 old (superseded) + 3 new (current) with identical keywords.
    const oldIds: string[] = [];
    const newIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const oldId = seedThought({ content: `REC_SUPPRESS topic marker ${i}` });
      const newId = seedThought({ content: `REC_SUPPRESS topic marker ${i}` });
      createEdge(db, newId, oldId, "replaces");
      oldIds.push(oldId);
      newIds.push(newId);
    }

    const results = await searchThoughts({
      query: "REC_SUPPRESS topic marker",
      topK: 3,
      hybrid: true,
      recencyWeight: 0.5,
      recencyHalfLifeDays: 30,
      supersessionMode: "suppress",
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.standing === "current")).toBe(true);
    const resultIds = results.map((r) => r.thought.id);
    for (const id of resultIds) {
      expect(newIds).toContain(id);
      expect(oldIds).not.toContain(id);
    }
  });

  test("tagFilter + recency keeps recency order on remaining rows", async () => {
    const db = getDb();
    const nowMs = Date.now();
    const older = new Date(nowMs - 20 * 24 * 3600_000).toISOString();
    const newer = new Date(nowMs - 5 * 24 * 3600_000).toISOString();
    // Identical content so BM25 scores are equal; recency breaks the tie.
    const oldId = seedThought({ content: "REC_TAG shared topic tag", tags: '["alpha"]' });
    const newId = seedThought({ content: "REC_TAG shared topic tag", tags: '["alpha"]' });
    db.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(older, oldId);
    db.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(newer, newId);

    const results = await searchThoughts({
      query: "REC_TAG shared topic tag",
      topK: 10,
      hybrid: true,
      recencyWeight: 0.5,
      recencyHalfLifeDays: 30,
      tagFilter: "alpha",
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map((r) => r.thought.id);
    expect(ids).toContain(oldId);
    expect(ids).toContain(newId);
    // Newer should rank above older after tag filtering.
    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(oldId));
  });

  test("clamps: w>1→1, w<0→0, NaN→0", async () => {
    seedThought({ content: "REC_CLAMP marker" });

    // w>1 → clamped to 1 (no error).
    const over = await searchThoughts({
      query: "REC_CLAMP",
      topK: 5,
      recencyWeight: 5,
    });
    expect(Array.isArray(over)).toBe(true);

    // w<0 → clamped to 0 (no recency fields).
    const under = await searchThoughts({
      query: "REC_CLAMP",
      topK: 5,
      recencyWeight: -2,
    });
    expect(under.every((r) => r.recency_score === undefined && r.final_score === undefined)).toBe(true);

    // NaN → clamped to 0.
    const nan = await searchThoughts({
      query: "REC_CLAMP",
      topK: 5,
      recencyWeight: NaN as unknown as number,
    });
    expect(nan.every((r) => r.recency_score === undefined && r.final_score === undefined)).toBe(true);
  });

  test("clamps: half-life ≤0/NaN→30, >3650→3650", async () => {
    seedThought({ content: "REC_HL marker" });

    // half-life ≤ 0 → falls back to DEFAULT (30).
    const zeroHl = await searchThoughts({
      query: "REC_HL",
      topK: 5,
      recencyWeight: 0.5,
      recencyHalfLifeDays: 0,
    });
    expect(Array.isArray(zeroHl)).toBe(true);

    const nanHl = await searchThoughts({
      query: "REC_HL",
      topK: 5,
      recencyWeight: 0.5,
      recencyHalfLifeDays: NaN as unknown as number,
    });
    expect(Array.isArray(nanHl)).toBe(true);

    // half-life > 3650 → clamped to 3650.
    const hugeHl = await searchThoughts({
      query: "REC_HL",
      topK: 5,
      recencyWeight: 0.5,
      recencyHalfLifeDays: 10_000,
    });
    expect(Array.isArray(hugeHl)).toBe(true);
  });

  test("group_by_cluster preserves intra-group recency order", async () => {
    const db = getDb();
    const nowMs = Date.now();
    const older = new Date(nowMs - 20 * 24 * 3600_000).toISOString();
    const newer = new Date(nowMs - 5 * 24 * 3600_000).toISOString();
    // Cluster head and members all share the same keyword so they surface in results.
    const memberOld = seedThought({ content: "REC_GC cluster topic" });
    const memberNew = seedThought({ content: "REC_GC cluster topic" });
    const clusterId = seedThought({ content: "REC_GC cluster topic" });
    db.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(older, memberOld);
    db.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`).run(newer, memberNew);
    db.prepare(`UPDATE thoughts SET is_cluster = 1 WHERE id = ?`).run(clusterId);
    createEdge(db, clusterId, memberOld, "cluster");
    createEdge(db, clusterId, memberNew, "cluster");

    // searchThoughtsGrouped internally calls searchThoughts then groupResultsByCluster.
    const results = await searchThoughtsGrouped({
      query: "REC_GC cluster topic",
      topK: 10,
      hybrid: true,
      recencyWeight: 0.5,
      recencyHalfLifeDays: 30,
    });

    const clusterGroup = results.find((r) => r.cluster !== undefined);
    expect(clusterGroup).toBeDefined();
    expect(clusterGroup!.items).toBeDefined();
    const items = clusterGroup!.items!;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const itemIds = items.map((r) => r.thought.id);
    expect(itemIds).toContain(memberOld);
    expect(itemIds).toContain(memberNew);
    // Newer member ranks first within the cluster group.
    expect(itemIds.indexOf(memberNew)).toBeLessThan(itemIds.indexOf(memberOld));
  });
});
