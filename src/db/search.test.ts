import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedEmbedding, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb, hasVec } from "./init";
import { bm25SearchIds, bm25SearchIdsFiltered, rrfMerge, searchThoughts } from "./search";

const itVec = test.skipIf(!hasVec());

beforeEach(createTestDb);
afterEach(closeDb);

itVec(
	"searchThoughts with minImportance filters out low-importance thoughts",
	() => {
		const db = getDb();
		const high = seedThought({ content: "important thought" });
		const low = seedThought({ content: "unimportant thought" });
		seedEmbedding(high);
		seedEmbedding(low);
		db.prepare(
			`UPDATE thought_importance SET importance = 0.2 WHERE thought_id = ?`,
		).run(low);

		const withFilter = searchThoughts(db, {
			embedding: new Float32Array(384),
			topK: 10,
			statusFilter: "active",
			minImportance: 0.5,
		});
		const withoutFilter = searchThoughts(db, {
			embedding: new Float32Array(384),
			topK: 10,
			statusFilter: "active",
		});

		expect(withoutFilter.map((r) => r.thought.id)).toContain(high);
		expect(withoutFilter.map((r) => r.thought.id)).toContain(low);

		const ids = withFilter.map((r) => r.thought.id);
		expect(ids).toContain(high);
		expect(ids).not.toContain(low);
	},
);

itVec("searchThoughts without minImportance does not filter", () => {
	const db = getDb();
	const t = seedThought({ content: "something" });
	seedEmbedding(t);
	db.prepare(
		`UPDATE thought_importance SET importance = 0.01 WHERE thought_id = ?`,
	).run(t);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
	});
	expect(results.map((r) => r.thought.id)).toContain(t);
});

itVec("searchThoughts with minImportance=0 returns all", () => {
	const db = getDb();
	const t = seedThought({ content: "something" });
	seedEmbedding(t);
	db.prepare(
		`UPDATE thought_importance SET importance = 0.01 WHERE thought_id = ?`,
	).run(t);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
		minImportance: 0,
	});
	expect(results.map((r) => r.thought.id)).toContain(t);
});

itVec("searchThoughts with excludeFlagged omits flagged thoughts", () => {
	const db = getDb();
	const clean = seedThought({ content: "clean thought" });
	const flagged = seedThought({ content: "flagged thought" });
	seedEmbedding(clean);
	seedEmbedding(flagged);
	db.prepare(
		`INSERT INTO thought_verify (thought_id, flagged) VALUES (?, 1)`,
	).run(flagged);

	const excluding = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
		excludeFlagged: true,
	});
	const keeping = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
	});

	expect(excluding.map((r) => r.thought.id)).toContain(clean);
	expect(excluding.map((r) => r.thought.id)).not.toContain(flagged);
	expect(keeping.map((r) => r.thought.id)).toContain(flagged);
});

// FTS5 / BM25 + RRF (no vector needed)

test("bm25SearchIds finds thoughts by exact keyword", () => {
	const db = getDb();
	seedThought({
		id: "bm25-a",
		content: "MCP 421 Misdirected Request through Caddy proxy",
	});
	seedThought({
		id: "bm25-b",
		content: "completely unrelated thought about rsync deploy",
	});
	const ids = bm25SearchIds(db, "Caddy", 10);
	expect(ids).toContain("bm25-a");
	expect(ids).not.toContain("bm25-b");
});

test("bm25SearchIds degrades to [] when FTS index missing", () => {
	expect(bm25SearchIds(getDb(), "anything", 10)).toEqual([]);
});

test("rrfMerge fuses two ranked lists, boosting shared ids", () => {
	const merged = rrfMerge([
		["x", "y", "z"],
		["y", "x"],
	]);
	const top2 = merged
		.slice(0, 2)
		.map((m) => m.id)
		.sort();
	expect(top2).toEqual(["x", "y"]);
	expect(merged[merged.length - 1].id).toBe("z");
});

test("hybrid search respects topK without vector search", () => {
	const db = getDb();
	for (let i = 0; i < 6; i++) {
		seedThought({ content: `TOPK_MARKER shared keyword ${i}` });
	}

	const results = searchThoughts(db, {
		embedding: new Float32Array(0),
		query: "TOPK_MARKER",
		topK: 3,
		statusFilter: "active",
		hybrid: true,
	});

	expect(results).toHaveLength(3);
});

itVec(
	"hybrid search surfaces an exact-keyword thought even with a useless embedding",
	() => {
		const db = getDb();
		const target = seedThought({
			content: "EXACTTOKEN_MARKER_xyz unique marker",
		});
		const other = seedThought({
			content: "completely unrelated text without marker",
		});
		seedEmbedding(target);
		seedEmbedding(other);
		const results = searchThoughts(db, {
			embedding: new Float32Array(384),
			query: "EXACTTOKEN_MARKER_xyz",
			topK: 10,
			statusFilter: "active",
			hybrid: true,
		});
		expect(results.map((r) => r.thought.id)).toContain(target);
	},
);

itVec("semantic baseline (hybrid=false) still returns vector results", () => {
	const db = getDb();
	const t = seedThought({ content: "semantic only baseline" });
	seedEmbedding(t);
	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
		hybrid: false,
	});
	expect(results.map((r) => r.thought.id)).toContain(t);
});

itVec("searchThoughts with statusFilter excludes non-matching status", () => {
	const db = getDb();
	const active = seedThought({ content: "active thought", status: "active" });
	const draft = seedThought({ content: "draft thought", status: "draft" });
	seedEmbedding(active);
	seedEmbedding(draft);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
	});
	expect(results.map((r) => r.thought.id)).toContain(active);
	expect(results.map((r) => r.thought.id)).not.toContain(draft);
});

itVec("searchThoughts with projectFilter scopes to project", () => {
	const db = getDb();
	const p1 = crypto.randomUUID()
	const p2 = crypto.randomUUID()
	db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'P1', ?)`).run(p1, new Date().toISOString())
	db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'P2', ?)`).run(p2, new Date().toISOString())

	const inP1 = seedThought({ content: "project one", project_id: p1 });
	const inP2 = seedThought({ content: "project two", project_id: p2 });
	seedEmbedding(inP1);
	seedEmbedding(inP2);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
		projectFilter: p1,
	});
	expect(results.map((r) => r.thought.id)).toContain(inP1);
	expect(results.map((r) => r.thought.id)).not.toContain(inP2);
});

itVec("searchThoughts with clusterFilter=only returns only clusters", () => {
	const db = getDb();
	const cluster = seedThought({ content: "cluster thought", is_cluster: 1 });
	const regular = seedThought({ content: "regular thought", is_cluster: 0 });
	seedEmbedding(cluster);
	seedEmbedding(regular);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
		clusterFilter: "only",
	});
	expect(results.map((r) => r.thought.id)).toContain(cluster);
	expect(results.map((r) => r.thought.id)).not.toContain(regular);
});

itVec("searchThoughts with clusterFilter=exclude hides clusters", () => {
	const db = getDb();
	const cluster = seedThought({ content: "cluster thought", is_cluster: 1 });
	const regular = seedThought({ content: "regular thought", is_cluster: 0 });
	seedEmbedding(cluster);
	seedEmbedding(regular);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		topK: 10,
		statusFilter: "active",
		clusterFilter: "exclude",
	});
	expect(results.map((r) => r.thought.id)).not.toContain(cluster);
	expect(results.map((r) => r.thought.id)).toContain(regular);
});

test("toFtsQuery escapes special characters", () => {
	// This tests the internal toFtsQuery indirectly through bm25SearchIds
	const db = getDb();
	seedThought({ id: "fts-safe", content: "normal thought without special chars" });
	// Should not throw even with special chars
	const ids = bm25SearchIds(db, 'test "quotes" AND OR NOT', 10);
	expect(Array.isArray(ids)).toBeTrue();
});

// ── bm25SearchIdsFiltered ────────────────────────────────────────────────────

test("bm25SearchIdsFiltered respects project filter", () => {
	const db = getDb();
	const p1 = crypto.randomUUID();
	const p2 = crypto.randomUUID();
	db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'P1', ?)`).run(p1, new Date().toISOString());
	db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'P2', ?)`).run(p2, new Date().toISOString());

	seedThought({ id: "bm25-proj-a", content: "Caddy proxy config in project one", project_id: p1 });
	seedThought({ id: "bm25-proj-b", content: "Caddy proxy config in project two", project_id: p2 });

	const filtered = bm25SearchIdsFiltered(db, "Caddy", 10, "AND t.project_id = ? ", [p1]);
	expect(filtered).toContain("bm25-proj-a");
	expect(filtered).not.toContain("bm25-proj-b");
});

test("bm25SearchIdsFiltered respects status filter", () => {
	const db = getDb();
	seedThought({ id: "bm25-status-a", content: "deploy workflow active", status: "active" });
	seedThought({ id: "bm25-status-b", content: "deploy workflow archived", status: "archived" });

	const filtered = bm25SearchIdsFiltered(db, "deploy", 10, "AND t.status = ? ", ["active"]);
	expect(filtered).toContain("bm25-status-a");
	expect(filtered).not.toContain("bm25-status-b");
});

test("bm25SearchIdsFiltered without filterSql falls back to unfiltered", () => {
	const db = getDb();
	seedThought({ id: "bm25-fb-a", content: "fallback test marker alpha" });
	seedThought({ id: "bm25-fb-b", content: "fallback test marker beta" });

	const result = bm25SearchIdsFiltered(db, "fallback", 10, "", []);
	expect(result).toContain("bm25-fb-a");
	expect(result).toContain("bm25-fb-b");
});

itVec("searchThoughts project-filtered BM25 returns topK when local thought exists", () => {
	const db = getDb();
	const p1 = crypto.randomUUID();
	const p2 = crypto.randomUUID();
	db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'P1', ?)`).run(p1, new Date().toISOString());
	db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'P2', ?)`).run(p2, new Date().toISOString());

	const local = seedThought({ content: "scoped search marker", project_id: p1 });
	const remote = seedThought({ content: "scoped search marker", project_id: p2 });
	seedEmbedding(local);
	seedEmbedding(remote);

	const results = searchThoughts(db, {
		embedding: new Float32Array(384),
		query: "scoped search marker",
		topK: 1,
		statusFilter: "active",
		projectFilter: p1,
		hybrid: true,
	});

	expect(results).toHaveLength(1);
	expect(results[0].thought.id).toBe(local);
});

// ── Ranking signal field regression (issue #143, task #816) ─────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "./init";

/** File-backed DB with vec0 available — needed for vector-leg assertions. */
function withVecTestDb(fn: (db: import("bun:sqlite").Database) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "synaptomind-search-signal-"));
  const dbPath = join(dir, "test.db");
  try {
    initDb({ dbPath, runMigrations: true });
    fn(getDb());
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedThoughtRow(db: import("bun:sqlite").Database, id: string, content: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_profile, is_protected, created_at, updated_at)
     VALUES (?, ?, 'active', 'test', 'default', 0, 1, 1, ?, ?)`,
  ).run(id, content, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO thought_importance (thought_id, importance, hit_count, last_decay, created_at)
     VALUES (?, 1.0, 0, ?, ?)`,
  ).run(id, now, now);
}

function seedVecEmbedding(db: import("bun:sqlite").Database, thoughtId: string): void {
  const buf = Buffer.from(new Float32Array(384).buffer);
  db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(thoughtId, buf);
}

function seedFts(db: import("bun:sqlite").Database, thoughtId: string, content: string): void {
  db.prepare(`INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`).run(thoughtId, content);
}

test("BM25-only hit carries match_source=['bm25'] and a positive bm25_score", () => {
  const db = getDb();
  seedThoughtRow(db, "sig-bm25-a", "EXACT_BM25_MARKER unique relevant content");
  seedThoughtRow(db, "sig-bm25-b", "completely unrelated text here");
  seedFts(db, "sig-bm25-a", "EXACT_BM25_MARKER unique relevant content");
  seedFts(db, "sig-bm25-b", "completely unrelated text here");

  const results = searchThoughts(db, {
    embedding: new Float32Array(0),
    query: "EXACT_BM25_MARKER",
    topK: 10,
    hybrid: true,
  });

  expect(results.length).toBeGreaterThanOrEqual(1);
  const hit = results.find((r) => r.thought.id === "sig-bm25-a");
  expect(hit).toBeDefined();
  expect(hit!.match_source).toEqual(["bm25"]);
  expect(hit!.bm25_score).toBeGreaterThan(0);
  expect(hit!.rrf_score).toBeDefined(); // fusion ran on hybrid path
});

test("higher BM25 relevance produces a higher bm25_score", () => {
  const db = getDb();
  // The repeated keyword makes this more relevant in BM25.
  seedThoughtRow(db, "sig-bm25-high", "KEYWORD marker KEYWORD marker KEYWORD");
  seedThoughtRow(db, "sig-bm25-low", "KEYWORD marker");
  seedFts(db, "sig-bm25-high", "KEYWORD marker KEYWORD marker KEYWORD");
  seedFts(db, "sig-bm25-low", "KEYWORD marker");

  const results = searchThoughts(db, {
    embedding: new Float32Array(0),
    query: "KEYWORD marker",
    topK: 10,
    hybrid: true,
  });

  const high = results.find((r) => r.thought.id === "sig-bm25-high");
  const low = results.find((r) => r.thought.id === "sig-bm25-low");
  expect(high).toBeDefined();
  expect(low).toBeDefined();
  expect(high!.bm25_score!).toBeGreaterThan(low!.bm25_score!);
});

test("non-matching thought has no bm25_score and no match_source entry for bm25", () => {
  const db = getDb();
  seedThoughtRow(db, "sig-no-bm25", "no matching keyword at all");
  seedFts(db, "sig-no-bm25", "no matching keyword at all");

  const results = searchThoughts(db, {
    embedding: new Float32Array(0),
    query: "zzz_nomatch_zzz",
    topK: 10,
    hybrid: true,
  });

  // No results at all for a non-matching query.
  const hit = results.find((r) => r.thought.id === "sig-no-bm25");
  expect(hit).toBeUndefined();
});

test("hybrid overlap hit lists both vector and bm25 in match_source", () => {
  withVecTestDb((db) => {
    seedThoughtRow(db, "sig-overlap", "HYBRID_OVERLAP marker test");
    seedVecEmbedding(db, "sig-overlap");
    seedFts(db, "sig-overlap", "HYBRID_OVERLAP marker test");

    const results = searchThoughts(db, {
      embedding: new Float32Array(384),
      query: "HYBRID_OVERLAP marker test",
      topK: 10,
      hybrid: true,
    });

    const hit = results.find((r) => r.thought.id === "sig-overlap");
    expect(hit).toBeDefined();
    expect(hit!.match_source).toEqual(["vector", "bm25"]);
    expect(hit!.rrf_score).toBeDefined();
    expect(hit!.bm25_score).toBeGreaterThan(0);
  });
});

test("vector-only hit has match_source=['vector'] with no bm25_score", () => {
  withVecTestDb((db) => {
    seedThoughtRow(db, "sig-vec-only", "semantic similarity content");
    seedVecEmbedding(db, "sig-vec-only");

    const results = searchThoughts(db, {
      embedding: new Float32Array(384),
      topK: 10,
      hybrid: false,
    });

    const hit = results.find((r) => r.thought.id === "sig-vec-only");
    expect(hit).toBeDefined();
    expect(hit!.match_source).toEqual(["vector"]);
    expect(hit!.bm25_score).toBeUndefined();
    expect(hit!.rrf_score).toBeUndefined();
  });
});

test("no-query path (hybrid=true, no query) is vector-only: rrf_score absent", () => {
  withVecTestDb((db) => {
    seedThoughtRow(db, "sig-noquery", "semantic content only");
    seedVecEmbedding(db, "sig-noquery");

    const results = searchThoughts(db, {
      embedding: new Float32Array(384),
      topK: 10,
      hybrid: true,
    });

    const hit = results.find((r) => r.thought.id === "sig-noquery");
    expect(hit).toBeDefined();
    expect(hit!.match_source).toEqual(["vector"]);
    expect(hit!.rrf_score).toBeUndefined();
    expect(hit!.bm25_score).toBeUndefined();
  });
});

test("entity hit includes 'entity' in match_source", () => {
  const db = getDb();
  seedThoughtRow(db, "sig-entity", "entity marker content");
  seedFts(db, "sig-entity", "entity marker content");

  const results = searchThoughts(db, {
    embedding: new Float32Array(0),
    query: "entity marker",
    topK: 10,
    hybrid: true,
    entitySearchIds: () => ["sig-entity"],
  });

  const hit = results.find((r) => r.thought.id === "sig-entity");
  expect(hit).toBeDefined();
  expect(hit!.match_source).toContain("entity");
  expect(hit!.match_source).toContain("bm25");
  expect(hit!.rrf_score).toBeDefined();
});

test("bm25SearchIds returns string[] (public contract preserved)", () => {
  const ids = bm25SearchIds(getDb(), "test", 10);
  expect(Array.isArray(ids)).toBe(true);
  expect(ids.every((id) => typeof id === "string")).toBe(true);
});

test("bm25SearchIdsFiltered returns string[] (public contract preserved)", () => {
  const ids = bm25SearchIdsFiltered(getDb(), "test", 10, "", []);
  expect(Array.isArray(ids)).toBe(true);
  expect(ids.every((id) => typeof id === "string")).toBe(true);
});
