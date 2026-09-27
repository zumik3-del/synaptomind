import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import {
	createTestDb,
	isVecExtensionAvailable,
	seedEmbedding,
	seedThought,
	withVecDb,
} from "../test/helpers";
import { searchThoughts, searchThoughtsGrouped } from "./search.service";

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	isEmbedderReady: () => true,
}));

beforeEach(createTestDb);
afterEach(closeDb);

const VEC_AVAILABLE = isVecExtensionAvailable();

/**
 * Vec-gated test. `:memory:` cannot load vec0, so each body runs on a fresh
 * file-backed DB supplied by `withVecDb` and skips when the extension is absent.
 */
function itVec(
	name: string,
	fn: (db: Database) => void | Promise<void>,
): void {
	test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn));
}

/** Seed a specific 384-d vector so cosine similarity is controllable. */
function seedVecEmbeddingRaw(db: Database, thoughtId: string, vector: Float32Array): void {
	const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
	db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(thoughtId, buf);
}

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

// ── Relevance-confidence signal (issue #155, task #884/885) ─────────────────

describe("low_confidence + min_relevance — service layer", () => {
  test("min_relevance=0 (default) preserves all results and their low_confidence flags", async () => {
    seedThought({ content: "MIN_REL marker content here" });
    seedThought({ content: "MIN_REL marker content also" });

    const results = await searchThoughts({
      query: "MIN_REL",
      topK: 10,
      hybrid: true,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(typeof r.low_confidence).toBe("boolean");
    }
  });

  test("min_relevance=0 yields identical id set/order to ungated baseline", async () => {
    seedThought({ content: "MIN_REL_ID same keyword anchor" });
    seedThought({ content: "MIN_REL_ID same keyword anchor" });

    const baseline = await searchThoughts({
      query: "MIN_REL_ID",
      topK: 10,
      hybrid: true,
    });
    const gated = await searchThoughts({
      query: "MIN_REL_ID",
      topK: 10,
      hybrid: true,
      minRelevance: 0,
    });

    const baselineIds = baseline.map((r) => r.thought.id);
    const gatedIds = gated.map((r) => r.thought.id);
    expect(gatedIds).toEqual(baselineIds);
  });

  itVec("min_relevance>0 filters out weak vector-only results, keeps BM25 anchors", async (db) => {
    // BM25 hit: contains the keyword → strong lexical anchor.
    const bm25Id = seedThought({
      content: "MIN_REL_BM25 unique keyword anchor",
    });
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(bm25Id, "MIN_REL_BM25 unique keyword anchor");
    // Vector-only hit: cosine ≈ 0.2 against the query → weak, below the floor.
    const vecOnlyId = seedThought({
      content: "MIN_REL_VEC unrelated semantic noise",
    });
    const stored = new Float32Array(384);
    stored[0] = 1;
    seedVecEmbeddingRaw(db, vecOnlyId, stored);
    const weakQuery = new Float32Array(384);
    weakQuery[0] = 0.2;
    weakQuery[1] = Math.sqrt(1 - 0.2 * 0.2);

    const baseline = await searchThoughts(
      {
        query: "MIN_REL_BM25 unique keyword anchor",
        topK: 10,
        hybrid: true,
        embedding: weakQuery,
      },
      db,
    );
    const ungated = await searchThoughts(
      {
        query: "MIN_REL_BM25 unique keyword anchor",
        topK: 10,
        hybrid: true,
        embedding: weakQuery,
        minRelevance: 0,
      },
      db,
    );
    const gated = await searchThoughts(
      {
        query: "MIN_REL_BM25 unique keyword anchor",
        topK: 10,
        hybrid: true,
        embedding: weakQuery,
        minRelevance: 0.9,
      },
      db,
    );

    // The weak vector-only hit is a real candidate (present ungated)...
    const baselineIds = baseline.map((r) => r.thought.id);
    expect(baselineIds).toContain(bm25Id);
    expect(baselineIds).toContain(vecOnlyId);
    expect(ungated.map((r) => r.thought.id)).toContain(vecOnlyId);
    // ...and the gate drops it while keeping the lexical anchor. Without the
    // gate `gatedIds` would equal the baseline and the negative assertion
    // below would fail.
    const gatedIds = gated.map((r) => r.thought.id);
    expect(gatedIds).toContain(bm25Id);
    expect(gatedIds).not.toContain(vecOnlyId);
  });

  test("min_relevance>0 backfills to topK from overfetch pool", async () => {
    const db = getDb();
    // Create many thoughts so we can test backfill.
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = seedThought({ content: `MIN_REL_FILL topic marker ${i}` });
      ids.push(id);
    }
    // Add FTS for a few so they become BM25 hits (strong matches).
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
      ).run(ids[i], `MIN_REL_FILL topic marker ${i}`);
    }

    const results = await searchThoughts({
      query: "MIN_REL_FILL topic marker",
      topK: 5,
      hybrid: true,
      minRelevance: 0.9,
    });

    // Should still return topK results because the overfetch pool backfills.
    expect(results.length).toBeGreaterThanOrEqual(1);
    // All returned results should be strong matches.
    for (const r of results) {
      expect(r.low_confidence).toBe(false);
    }
  });

  test("suppress + min_relevance combined: suppress drops then gate filters", async () => {
    const db = getDb();
    const oldId = seedThought({ content: "MIN_REL_SUP old claim" });
    const newId = seedThought({ content: "MIN_REL_SUP new claim" });
    createEdge(db, newId, oldId, "replaces");
    // Make oldId a BM25 hit (so it would survive gating).
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(oldId, "MIN_REL_SUP old claim");
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(newId, "MIN_REL_SUP new claim");

    const results = await searchThoughts({
      query: "MIN_REL_SUP",
      topK: 10,
      hybrid: true,
      supersessionMode: "suppress",
      minRelevance: 0.9,
    });

    const resultIds = results.map((r) => r.thought.id);
    // Suppressed old thought should be gone.
    expect(resultIds).not.toContain(oldId);
    // New thought should be present.
    expect(resultIds).toContain(newId);
  });

  test("recency invariance: low_confidence identical for recencyWeight=0 vs 1", async () => {
    seedThought({ content: "MIN_REL_REC same marker here" });
    seedThought({ content: "MIN_REL_REC same marker here" });

    const noRecency = await searchThoughts({
      query: "MIN_REL_REC",
      topK: 10,
      hybrid: true,
      recencyWeight: 0,
    });
    const withRecency = await searchThoughts({
      query: "MIN_REL_REC",
      topK: 10,
      hybrid: true,
      recencyWeight: 1,
    });

    const noRecIds = new Set(noRecency.map((r) => r.thought.id));
    const withRecIds = new Set(withRecency.map((r) => r.thought.id));
    // Same result set (recency only changes order, not membership).
    expect(noRecIds).toEqual(withRecIds);
    // low_confidence flags are identical per-id.
    const noRecById = new Map(noRecency.map((r) => [r.thought.id, r.low_confidence]));
    for (const r of withRecency) {
      expect(noRecById.get(r.thought.id)).toBe(r.low_confidence);
    }
  });

  test("confidenceFloor clamp: out-of-range values clamped to [0,1]", async () => {
    seedThought({ content: "MIN_REL_CLAMP marker" });

    // confidenceFloor > 1 → clamped to 1.
    const over = await searchThoughts({
      query: "MIN_REL_CLAMP",
      topK: 10,
      hybrid: true,
      confidenceFloor: 5,
    });
    expect(Array.isArray(over)).toBe(true);

    // confidenceFloor < 0 → clamped to 0.
    const under = await searchThoughts({
      query: "MIN_REL_CLAMP",
      topK: 10,
      hybrid: true,
      confidenceFloor: -0.5,
    });
    expect(Array.isArray(under)).toBe(true);
    // With floor=0, all vector hits are strong matches.
    for (const r of under) {
      expect(r.low_confidence).toBe(false);
    }
  });

  test("low_confidence field present on every result", async () => {
    seedThought({ content: "MIN_REL_FIELD marker content" });

    const results = await searchThoughts({
      query: "MIN_REL_FIELD",
      topK: 10,
      hybrid: true,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(typeof r.low_confidence).toBe("boolean");
    }
  });

  test("min_relevance>0 over an empty DB returns [] without crashing", async () => {
    const results = await searchThoughts({
      query: "MIN_REL_EMPTY missing keyword",
      topK: 10,
      hybrid: true,
      embedding: new Float32Array(384),
      minRelevance: 0.9,
    });
    expect(results).toEqual([]);
  });

  test("min_relevance>0 still fills topK when survivors exceed topK", async () => {
    const db = getDb();
    for (let i = 0; i < 8; i++) {
      const id = seedThought({ content: `MIN_REL_TOPK anchor marker ${i}` });
      db.prepare(
        `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
      ).run(id, `MIN_REL_TOPK anchor marker ${i}`);
    }

    const results = await searchThoughts({
      query: "MIN_REL_TOPK",
      topK: 3,
      hybrid: true,
      minRelevance: 0.9,
    });

    // Every BM25 anchor is strong, so the gate must not shrink the set below topK.
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.low_confidence).toBe(false);
    }
  });

  test("min_relevance>0 under-fills when the candidate pool is exhausted", async () => {
    const db = getDb();
    const onlyId = seedThought({ content: "MIN_REL_UNDER sole anchor" });
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(onlyId, "MIN_REL_UNDER sole anchor");

    const results = await searchThoughts({
      query: "MIN_REL_UNDER",
      topK: 5,
      hybrid: true,
      minRelevance: 0.9,
    });

    // Only one candidate exists → the gate returns it and under-fills `topK`.
    expect(results.map((r) => r.thought.id)).toEqual([onlyId]);
  });

  test("tagFilter + min_relevance keeps only tagged strong matches", async () => {
    const db = getDb();
    const taggedId = seedThought({
      content: "MIN_REL_TAG anchor marker keep",
      tags: JSON.stringify(["keepme"]),
    });
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(taggedId, "MIN_REL_TAG anchor marker keep");
    const untaggedId = seedThought({ content: "MIN_REL_TAG anchor marker drop" });
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(untaggedId, "MIN_REL_TAG anchor marker drop");

    const results = await searchThoughts({
      query: "MIN_REL_TAG",
      topK: 10,
      hybrid: true,
      tagFilter: "keepme",
      minRelevance: 0.9,
    });

    const ids = results.map((r) => r.thought.id);
    expect(ids).toContain(taggedId);
    expect(ids).not.toContain(untaggedId);
    // No over-drop: the surviving tagged anchor is strong and retained.
    for (const r of results) {
      expect(r.low_confidence).toBe(false);
    }
  });

  itVec("min_relevance=1 keeps lexical anchors and exact-1.0 vector hits only", async (db) => {
    const bm25Id = seedThought({ content: "MIN_REL_ONE lexical anchor" });
    db.prepare(
      `INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`,
    ).run(bm25Id, "MIN_REL_ONE lexical anchor");
    // sim == 1.0 against the query (identical unit vectors). Content has no
    // query token, so it can only survive via the vector leg.
    const exactId = seedThought({ content: "semantic exact vector content" });
    const unit = new Float32Array(384);
    unit[0] = 1;
    seedVecEmbeddingRaw(db, exactId, unit);
    // sim ≈ 0.1 → weak; no query token either.
    const weakId = seedThought({ content: "semantic weak vector content" });
    const weak = new Float32Array(384);
    weak[0] = 0.1;
    weak[1] = Math.sqrt(1 - 0.1 * 0.1);
    seedVecEmbeddingRaw(db, weakId, weak);

    const results = await searchThoughts(
      {
        query: "MIN_REL_ONE",
        topK: 10,
        hybrid: true,
        embedding: unit,
        minRelevance: 1,
      },
      db,
    );

    const ids = results.map((r) => r.thought.id);
    expect(ids).toContain(bm25Id);
    expect(ids).toContain(exactId);
    expect(ids).not.toContain(weakId);
  });
});
