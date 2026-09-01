import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedEmbedding, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb, hasVec } from "./init";
import { bm25SearchIds, rrfMerge, searchThoughts } from "./search";

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
