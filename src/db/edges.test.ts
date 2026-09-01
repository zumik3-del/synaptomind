import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import {
	createEdge,
	deleteEdge,
	getAllActiveEdges,
	getEdgesForThought,
} from "./edges";
import { getDb } from "./container";
import { closeDb } from "./init";
import { getThoughtImportance } from "./thoughts";

beforeEach(createTestDb);
afterEach(closeDb);

test("createEdge links two thoughts", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	const edge = createEdge(db, src, tgt, "develops");
	expect(edge.source_id).toBe(src);
	expect(edge.target_id).toBe(tgt);
	expect(edge.type).toBe("develops");
});

test("createEdge defaults type to related", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	const edge = createEdge(db, src, tgt);
	expect(edge.type).toBe("related");
});

test("deleteEdge removes existing edge", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	const edge = createEdge(db, src, tgt);
	const removed = deleteEdge(db, edge.id);
	expect(removed).toBeTrue();
	expect(getEdgesForThought(db, src)).toHaveLength(0);
});

test("deleteEdge returns false for missing edge", () => {
	expect(deleteEdge(getDb(), "nonexistent")).toBeFalse();
});

test("getEdgesForThought returns inbound and outbound edges", () => {
	const db = getDb();
	const a = seedThought();
	const b = seedThought();
	const c = seedThought();
	createEdge(db, a, b);
	createEdge(db, b, c);

	const edges = getEdgesForThought(db, b);
	expect(edges).toHaveLength(2);
});

test("getEdgesForThought returns empty for isolated thought", () => {
	const id = seedThought();
	expect(getEdgesForThought(getDb(), id)).toHaveLength(0);
});

test("migration v12 creates idx_edges_target index", () => {
	const db = getDb();
	const indexes = db.prepare(`PRAGMA index_list('edges')`).all() as {
		name: string;
	}[];
	expect(indexes.map((i) => i.name)).toContain("idx_edges_target");
});

test("incoming edges query uses idx_edges_target (no full scan)", () => {
	const db = getDb();
	const clusterLookup = db
		.prepare(
			`EXPLAIN QUERY PLAN SELECT source_id FROM edges WHERE target_id = ? AND type = 'cluster'`,
		)
		.all("t1") as { detail: string }[];
	expect(clusterLookup.map((r) => r.detail).join("\n")).toContain(
		"USING INDEX idx_edges_target",
	);

	const edgesLookup = db
		.prepare(
			`EXPLAIN QUERY PLAN SELECT * FROM edges WHERE source_id = ? OR target_id = ?`,
		)
		.all("t1", "t2") as { detail: string }[];
	const details = edgesLookup.map((r) => r.detail).join("\n");
	expect(details).not.toContain("SCAN edges");
});

test("getAllActiveEdges only returns edges where both source and target are active", () => {
	const db = getDb();
	const active = seedThought({ status: "active" });
	const archived = seedThought({ status: "archived" });
	const other = seedThought({ status: "active" });

	createEdge(db, active, other);
	createEdge(db, active, archived);

	const all = getAllActiveEdges(db);
	expect(all).toHaveLength(1);
	expect(all[0].source_id).toBe(active);
	expect(all[0].target_id).toBe(other);
});

test("duplicate edge throws UNIQUE constraint error", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	createEdge(db, src, tgt, "develops");
	expect(() => createEdge(db, src, tgt, "develops")).toThrow();
});

test("self-loop edge is rejected for every type (issue #157)", () => {
	const db = getDb();
	const id = seedThought();
	for (const type of [
		"related",
		"parent",
		"replaces",
		"develops",
		"cluster",
		"references",
	]) {
		expect(() => createEdge(db, id, id, type)).toThrow(
			"cannot link a thought to itself",
		);
	}
});

test("reverse directed edge is rejected (issue #157)", () => {
	const db = getDb();
	for (const type of ["parent", "replaces", "develops"]) {
		const a = seedThought();
		const b = seedThought();
		createEdge(db, a, b, type);
		expect(() => createEdge(db, b, a, type)).toThrow("already exists between");
	}
});

test("different edge type between the same pair is rejected (one edge per pair)", () => {
	const db = getDb();
	const a = seedThought();
	const b = seedThought();
	createEdge(db, a, b, "develops");
	expect(() => createEdge(db, a, b, "related")).toThrow(
		"already exists between",
	);
	expect(() => createEdge(db, b, a, "related")).toThrow(
		"already exists between",
	);
});

test("reverse related pair is deduped, returns existing edge (issue #157)", () => {
	const db = getDb();
	const a = seedThought();
	const b = seedThought();
	const first = createEdge(db, a, b, "related");
	const second = createEdge(db, b, a, "related");
	expect(second.id).toBe(first.id);
	expect(getEdgesForThought(db, a)).toHaveLength(1);
});

test("createEdge references deletes when source thought is removed", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	createEdge(db, src, tgt);
	db.prepare("DELETE FROM thoughts WHERE id = ?").run(src);
	expect(getEdgesForThought(db, tgt)).toHaveLength(0);
});

// Cluster edge validation
test("cluster edge requires cluster source", () => {
	const db = getDb();
	const normal = seedThought();
	const member = seedThought();
	expect(() => createEdge(db, normal, member, "cluster")).toThrow(
		"Only cluster thoughts can create 'cluster' edges",
	);
});

test("cluster edge cannot target a cluster", () => {
	const db = getDb();
	const cluster = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(cluster);
	const other = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(other);
	expect(() => createEdge(db, cluster, other, "cluster")).toThrow(
		"Cluster edges cannot target another cluster thought",
	);
});

test("cluster edge from cluster to normal thought succeeds", () => {
	const db = getDb();
	const cluster = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(cluster);
	const member = seedThought();
	const edge = createEdge(db, cluster, member, "cluster");
	expect(edge.type).toBe("cluster");
	expect(edge.source_id).toBe(cluster);
	expect(edge.target_id).toBe(member);
});

test("references from cluster to non-cluster fails", () => {
	const db = getDb();
	const cluster = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(cluster);
	const normal = seedThought();
	expect(() => createEdge(db, cluster, normal, "references")).toThrow(
		"Clusters can reference only other clusters via 'references'",
	);
});

test("references from non-cluster to cluster fails", () => {
	const db = getDb();
	const normal = seedThought();
	const cluster = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(cluster);
	expect(() => createEdge(db, normal, cluster, "references")).toThrow(
		"Non-cluster thoughts cannot use 'references' to link to clusters",
	);
});

test("references between two clusters succeeds", () => {
	const db = getDb();
	const c1 = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(c1);
	const c2 = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(c2);
	const edge = createEdge(db, c1, c2, "references");
	expect(edge.type).toBe("references");
});

test("regular edge types cannot involve clusters", () => {
	const db = getDb();
	const cluster = seedThought();
	db.prepare("UPDATE thoughts SET is_cluster = 1 WHERE id = ?").run(cluster);
	const normal = seedThought();

	expect(() => createEdge(db, cluster, normal, "parent")).toThrow(
		"Cluster thoughts cannot have 'parent' edges",
	);
	expect(() => createEdge(db, normal, cluster, "develops")).toThrow(
		/Cannot link to cluster thought using/,
	);
	expect(() => createEdge(db, cluster, normal, "related")).toThrow(
		"Cluster thoughts cannot have 'related' edges",
	);
});

test("createEdge boosts source thought importance by 0.1", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	const before = getThoughtImportance(db, src)?.importance;
	expect(before).toBe(1.0);
	createEdge(db, src, tgt, "develops");
	const after = getThoughtImportance(db, src);
	expect(after?.importance).toBeCloseTo(1.0, 5);
});

test("createEdge boosts source importance when below cap", () => {
	const db = getDb();
	const src = seedThought();
	const tgt = seedThought();
	db.prepare(
		`UPDATE thought_importance SET importance = 0.5 WHERE thought_id = ?`,
	).run(src);
	createEdge(db, src, tgt, "related");
	const after = getThoughtImportance(db, src);
	expect(after?.importance).toBeCloseTo(0.6, 5);
});
