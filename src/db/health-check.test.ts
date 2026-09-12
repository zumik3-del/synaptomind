import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, seedEdge, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	deleteEdges,
	deleteThoughts,
	findBrokenParentChains,
	findCircularChains,
	findClusterViolations,
	findClusterlessDense,
	findDeadPrimers,
	findDuplicateContent,
	findDuplicateEdges,
	findEmptyClusters,
	findImportanceOutliers,
	findIslandThoughts,
	findMissingEmbeddings,
	findOrphanEdges,
	findOrphanedClusterMembers,
	findReplacesChains,
	findSelfLoopEdges,
	findStaleDrafts,
	findTestRemnants,
	findTooShort,
	findUntagged,
	findOverlinkedThoughts,
	findSingletonClusters,
	getGraphStats,
} from "./health-check";

beforeEach(createTestDb);
afterEach(closeDb);

// :memory: test DBs skip the vec0 extension — a plain table with an
// `embedding` BLOB column satisfies every vec_thoughts query used here.
function seedVecTable(db: Database): void {
	db.prepare(
		`CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)`,
	).run();
}

function seedVecRow(db: Database, thoughtId: string): void {
	db.prepare(
		`INSERT OR REPLACE INTO vec_thoughts (id, embedding) VALUES (?, ?)`,
	).run(thoughtId, Buffer.alloc(0));
}

function seedPrimer(db: Database, thoughtId: string, hitCount: number): void {
	db.prepare(
		`INSERT INTO primers (id, thought_id, hit_count, created_at) VALUES (?, ?, ?, ?)`,
	).run(crypto.randomUUID(), thoughtId, hitCount, new Date().toISOString());
}

function setThoughtAge(id: string, daysAgo: number): void {
	getDb()
		.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`)
		.run(new Date(Date.now() - daysAgo * 86400000).toISOString(), id);
}

function insertRawEdge(
	db: Database,
	sourceId: string,
	targetId: string,
	type = "related",
): string {
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`,
	).run(id, sourceId, targetId, type, new Date().toISOString());
	return id;
}

function dropThought(db: Database, id: string): void {
	db.run("PRAGMA foreign_keys = OFF");
	db.prepare(`DELETE FROM thoughts WHERE id = ?`).run(id);
	db.run("PRAGMA foreign_keys = ON");
}

// ── Structural integrity ─────────────────────────────────────────────────────

test("findOrphanEdges reports which side is missing", () => {
	const db = getDb();
	const a = seedThought({ content: "kept thought" });
	const b = seedThought({ content: "deleted thought" });
	const e1 = insertRawEdge(db, a, b);
	const e2 = insertRawEdge(db, b, a);
	// an edge whose both endpoints never existed — FK must be bypassed to seed it
	db.run("PRAGMA foreign_keys = OFF");
	const e3 = insertRawEdge(db, crypto.randomUUID(), crypto.randomUUID());
	db.run("PRAGMA foreign_keys = ON");
	dropThought(db, b);

	const orphans = findOrphanEdges(db);
	const byId = new Map(orphans.map((o) => [o.id, o]));
	// missing_side names the side whose thought row is gone
	expect(byId.get(e1)?.missing_side).toBe("target"); // a→b, b deleted
	expect(byId.get(e2)?.missing_side).toBe("source"); // b→a, b deleted
	expect(byId.get(e3)?.missing_side).toBe("both");
});

test("findSelfLoopEdges finds source = target edges", () => {
	const db = getDb();
	const a = seedThought({ content: "self loop" });
	const b = seedThought({ content: "normal" });
	seedEdge(a, a, "related");
	seedEdge(a, b, "related");

	const loops = findSelfLoopEdges(db);
	expect(loops).toHaveLength(1);
	expect(loops[0]?.source_id).toBe(a);
});

test("findDuplicateEdges groups identical source/target/type pairs", () => {
	const db = getDb();
	const a = seedThought({ content: "thought a" });
	const b = seedThought({ content: "thought b" });
	seedEdge(a, b, "related");
	seedEdge(b, a, "related"); // opposite direction is a different pair

	// The live schema forbids exact duplicates (UNIQUE(source_id, target_id,
	// type) is a table constraint, so the index cannot be dropped) — rebuild
	// the table without it, which is exactly the legacy state this finder
	// exists to detect.
	db.run(`CREATE TABLE edges_dup (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL,
		target_id TEXT NOT NULL,
		type TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`);
	db.run(`INSERT INTO edges_dup SELECT * FROM edges`);
	db.run(`DROP TABLE edges`);
	db.run(`ALTER TABLE edges_dup RENAME TO edges`);
	db.prepare(
		`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`,
	).run(crypto.randomUUID(), a, b, "related", new Date().toISOString());

	const dupes = findDuplicateEdges(db);
	expect(dupes).toHaveLength(1);
	expect(dupes[0]?.source_id).toBe(a);
	expect(dupes[0]?.target_id).toBe(b);
	expect(dupes[0]?.count).toBe(2);
});

test("findClusterViolations detects a cluster edge between regular thoughts", () => {
	const db = getDb();
	const a = seedThought({ content: "regular a" });
	const b = seedThought({ content: "regular b" });
	seedEdge(a, b, "cluster");

	const violations = findClusterViolations(db);
	expect(violations).toHaveLength(1);
	expect(violations[0]?.thought_id).toBe(a);
	expect(violations[0]?.edge_type).toBe("cluster");
});

test("findBrokenParentChains finds parent edges into archived/draft thoughts", () => {
	const db = getDb();
	const parent = seedThought({ content: "active parent" });
	const archived = seedThought({ content: "archived child", status: "archived" });
	const draft = seedThought({ content: "draft child", status: "draft" });
	const active = seedThought({ content: "active child" });
	seedEdge(parent, archived, "parent");
	seedEdge(parent, draft, "develops");
	seedEdge(parent, active, "parent");

	const broken = findBrokenParentChains(db);
	expect(broken).toHaveLength(2);
	expect(broken.map((b) => b.target_status).sort()).toEqual(["archived", "draft"]);
});

test("findCircularChains detects a parent cycle", () => {
	const db = getDb();
	const a = seedThought({ content: "cycle a" });
	const b = seedThought({ content: "cycle b" });
	const c = seedThought({ content: "cycle c" });
	seedEdge(a, b, "parent");
	seedEdge(b, c, "parent");
	seedEdge(c, a, "parent");

	const cycles = findCircularChains(db);
	expect(cycles).toHaveLength(1);
	expect(cycles[0]?.cycle.sort()).toEqual([a, b, c].sort());
});

test("findCircularChains returns nothing for an acyclic graph", () => {
	const db = getDb();
	const a = seedThought({ content: "root" });
	const b = seedThought({ content: "child" });
	seedEdge(a, b, "parent");

	expect(findCircularChains(db)).toEqual([]);
});

test("findReplacesChains walks replaces edges to their end", () => {
	const db = getDb();
	const a = seedThought({ content: "v1" });
	const b = seedThought({ content: "v2" });
	const c = seedThought({ content: "v3" });
	seedEdge(a, b, "replaces");
	seedEdge(b, c, "replaces");

	const chains = findReplacesChains(db);
	expect(chains).toHaveLength(1);
	expect(chains[0]?.chain).toEqual([a, b, c]);
});

// ── Cluster health ───────────────────────────────────────────────────────────

test("findEmptyClusters finds clusters without member edges", () => {
	const db = getDb();
	const empty = seedThought({ content: "empty cluster", is_cluster: 1 });
	const populated = seedThought({ content: "populated cluster", is_cluster: 1 });
	const member = seedThought({ content: "member" });
	seedEdge(populated, member, "cluster");

	const empties = findEmptyClusters(db);
	expect(empties).toHaveLength(1);
	expect(empties[0]?.id).toBe(empty);
});

test("findSingletonClusters separates 0/1-member clusters from real ones", () => {
	const db = getDb();
	const emptyCluster = seedThought({ content: "empty cluster", is_cluster: 1 });
	const singleton = seedThought({ content: "singleton cluster", is_cluster: 1 });
	const big = seedThought({ content: "big cluster", is_cluster: 1 });
	seedEdge(singleton, seedThought({ content: "only member" }), "cluster");
	seedEdge(big, seedThought({ content: "member one" }), "cluster");
	seedEdge(big, seedThought({ content: "member two" }), "cluster");

	const singletons = findSingletonClusters(db);
	const byId = new Map(singletons.map((s) => [s.id, s.member_count]));
	expect(byId.get(emptyCluster)).toBe(0);
	expect(byId.get(singleton)).toBe(1);
	expect(byId.has(big)).toBe(false);
});

test("findOrphanedClusterMembers finds cluster edges from non-cluster sources", () => {
	const db = getDb();
	const fake = seedThought({ content: "not a cluster" });
	const member = seedThought({ content: "member" });
	const edgeId = seedEdge(fake, member, "cluster");

	const orphans = findOrphanedClusterMembers(db);
	expect(orphans).toHaveLength(1);
	expect(orphans[0]?.thought_id).toBe(member);
	expect(orphans[0]?.cluster_edge_id).toBe(edgeId);
});

test("findClusterlessDense finds well-connected thoughts outside any cluster", () => {
	const db = getDb();
	const dense = seedThought({ content: "dense thought" });
	const clustered = seedThought({ content: "clustered thought" });
	const cluster = seedThought({ content: "its cluster", is_cluster: 1 });
	for (let i = 0; i < 2; i++) {
		seedEdge(dense, seedThought({ content: `dense peer ${i}` }), "related");
		seedEdge(clustered, seedThought({ content: `clustered peer ${i}` }), "related");
	}
	seedEdge(cluster, clustered, "cluster");

	const denseOnes = findClusterlessDense(db, 2);
	expect(denseOnes).toHaveLength(1);
	expect(denseOnes[0]?.id).toBe(dense);
	expect(denseOnes[0]?.edge_count).toBe(2);
});

// ── Connectivity ─────────────────────────────────────────────────────────────

test("findIslandThoughts finds active unconnected regular thoughts only", () => {
	const db = getDb();
	const island = seedThought({ content: "island thought" });
	const connected = seedThought({ content: "connected thought" });
	const cluster = seedThought({ content: "lonely cluster", is_cluster: 1 });
	const profile = seedThought({ content: "lonely profile", is_profile: 1 });
	seedEdge(connected, seedThought({ content: "peer" }), "related");

	const islandIds = findIslandThoughts(db).map((i) => i.id);
	// clusters and profiles are exempt; connected thoughts are not islands
	expect(islandIds).toEqual([island]);
	expect(islandIds).not.toContain(cluster);
	expect(islandIds).not.toContain(profile);
	expect(islandIds).not.toContain(connected);
});

test("findOverlinkedThoughts respects the maxEdges threshold", () => {
	const db = getDb();
	const hub = seedThought({ content: "hub thought" });
	for (let i = 0; i < 3; i++) {
		seedEdge(hub, seedThought({ content: `peer ${i}` }), "related");
	}

	expect(findOverlinkedThoughts(db, 2).map((o) => o.id)).toEqual([hub]);
	expect(findOverlinkedThoughts(db, 3)).toEqual([]); // > maxEdges, not >=
});

// ── Content quality ──────────────────────────────────────────────────────────

test("findDuplicateContent pairs identical long contents", () => {
	const db = getDb();
	const a = seedThought({ content: "identical long content here" });
	const b = seedThought({ content: "identical long content here" });
	seedThought({ content: "unique other content" });

	const dupes = findDuplicateContent(db);
	expect(dupes).toHaveLength(1);
	expect(dupes[0]?.similarity).toBe(1.0);
	expect([dupes[0]?.id_a, dupes[0]?.id_b].sort()).toEqual([a, b].sort());
});

test("findDuplicateContent ignores pairs with an archived side", () => {
	const db = getDb();
	// Both sides active → still reported.
	const activeA = seedThought({ content: "duplicate active pair content" });
	const activeB = seedThought({ content: "duplicate active pair content" });
	// One side archived → the active survivor is not a duplicate.
	const activeTwin = seedThought({ content: "archived side pair content" });
	const archivedTwin = seedThought({
		content: "archived side pair content",
		status: "archived",
	});
	// Both sides archived → legacy garbage, not actionable.
	seedThought({ content: "both archived pair content", status: "archived" });
	seedThought({ content: "both archived pair content", status: "archived" });

	const dupes = findDuplicateContent(db);
	expect(dupes).toHaveLength(1);
	const flagged = [dupes[0]?.id_a, dupes[0]?.id_b].sort();
	expect(flagged).toEqual([activeA, activeB].sort());
	expect(flagged).not.toContain(activeTwin);
	expect(flagged).not.toContain(archivedTwin);
});

test("findTooShort uses a 10-char default and skips clusters", () => {
	const db = getDb();
	const short = seedThought({ content: "hi" });
	seedThought({ content: "exactly ten" }); // length 11 → fine
	seedThought({ content: "tiny", is_cluster: 1 }); // clusters exempt

	const shorts = findTooShort(db);
	expect(shorts).toHaveLength(1);
	expect(shorts[0]?.id).toBe(short);
	expect(shorts[0]?.length).toBe(2);
});

test("findTestRemnants flags test-looking content", () => {
  const db = getDb();
  const remnant = seedThought({ content: "Test thought A" });
  const likePrefix = seedThought({ content: "test another remnant" });
  seedThought({ content: "a perfectly normal thought" });
  // Archived test remnants should NOT be reported.
  const archivedRemnant = seedThought({ content: "Test thought B", status: "archived" });

  const remnants = findTestRemnants(db);
  const ids = remnants.map((r) => r.id);
  expect(ids).toContain(remnant);
  expect(ids).toContain(likePrefix);
  expect(ids).not.toContain(archivedRemnant);
  expect(ids).toHaveLength(2);
});

test("findTestRemnants ignores long notes that only look like test content", () => {
  const db = getDb();
  // Starts with "Test " but is a long, durable ops note (>120 chars).
  const longTestPrefix =
    "Test DBs must live on /tmp for acceptable fsync speed; production data on a slow mount makes every write block and the whole suite flaky.";
  // Contains "test ... thought" in prose but is a long, real note (>120 chars).
  const longProse =
    "When writing an integration test for the graph engine, a thought that mentions a test in prose is still a real note, not a leftover fixture, as long as it carries durable knowledge.";
  expect(longTestPrefix.length).toBeGreaterThan(120);
  expect(longProse.length).toBeGreaterThan(120);
  const longPrefix = seedThought({ content: longTestPrefix });
  const longProseNote = seedThought({ content: longProse });
  // The short fixtures from the previous test are still flagged.
  const shortRemnant = seedThought({ content: "Test thought A" });

  const ids = findTestRemnants(db).map((r) => r.id);
  expect(ids).not.toContain(longPrefix);
  expect(ids).not.toContain(longProseNote);
  expect(ids).toContain(shortRemnant);
  expect(ids).toHaveLength(1);
});

test("findBrokenParentChains does not flag edges from an archived source", () => {
  const db = getDb();
  const archivedParent = seedThought({ content: "archived parent", status: "archived" });
  const draftChild = seedThought({ content: "draft child", status: "draft" });
  const activeParent = seedThought({ content: "active parent" });
  // Edge from archived parent → draft child should be ignored.
  seedEdge(archivedParent, draftChild, "parent");
  // Edge from active parent → draft child should still be flagged.
  seedEdge(activeParent, draftChild, "parent");

  const broken = findBrokenParentChains(db);
  expect(broken).toHaveLength(1);
  expect(broken[0]?.source_id).toBe(activeParent);
});

test("findStaleDrafts finds old drafts only", () => {
	const db = getDb();
	const oldDraft = seedThought({ content: "old draft", status: "draft" });
	setThoughtAge(oldDraft, 60);
	seedThought({ content: "fresh draft", status: "draft" });
	const oldActive = seedThought({ content: "old active", status: "active" });
	setThoughtAge(oldActive, 60);

	const stale = findStaleDrafts(db);
	expect(stale).toHaveLength(1);
	expect(stale[0]?.id).toBe(oldDraft);
	expect(stale[0]?.age_days).toBeGreaterThanOrEqual(59);
});

test("findUntagged finds active untagged regular thoughts", () => {
	const db = getDb();
	const untagged = seedThought({ content: "no tags here" });
	seedThought({ content: "has tags", tags: '["tagged"]' });
	seedThought({ content: "draft without tags", status: "draft" });

	const untaggedList = findUntagged(db);
	expect(untaggedList).toHaveLength(1);
	expect(untaggedList[0]?.id).toBe(untagged);
});

test("findImportanceOutliers reports low and high extremes", () => {
	const db = getDb();
	const low = seedThought({ content: "low importance" });
	const high = seedThought({ content: "high importance" });
	seedThought({ content: "normal importance" });
	// trg_thought_importance_insert forces importance 1.0 on INSERT, so the
	// value must be set directly to simulate drifted scores
	db.prepare(`UPDATE thought_importance SET importance = 0.05 WHERE thought_id = ?`).run(low);
	db.prepare(`UPDATE thought_importance SET importance = 11 WHERE thought_id = ?`).run(high);

	const outliers = findImportanceOutliers(db);
	const byId = new Map(outliers.map((o) => [o.id, o.direction]));
	expect(byId.get(low)).toBe("low");
	expect(byId.get(high)).toBe("high");
	expect(outliers).toHaveLength(2);
});

test("findDeadPrimers finds primers with no hits", () => {
	const db = getDb();
	const dead = seedThought({ content: "dead primer thought" });
	const alive = seedThought({ content: "alive primer thought" });
	seedPrimer(db, dead, 0);
	seedPrimer(db, alive, 5);

	const deadOnes = findDeadPrimers(db);
	expect(deadOnes).toHaveLength(1);
	expect(deadOnes[0]?.thought_id).toBe(dead);
	expect(deadOnes[0]?.hit_count).toBe(0);
});

test("findMissingEmbeddings compares thoughts against the vec table", () => {
	const db = getDb();
	seedVecTable(db);
	const embedded = seedThought({ content: "has embedding" });
	seedVecRow(db, embedded);
	const missing = seedThought({ content: "no embedding" });
	const draft = seedThought({ content: "draft no embedding", status: "draft" });

	const missingList = findMissingEmbeddings(db);
	expect(missingList.map((m) => m.id)).toEqual([missing]);
	expect(missingList.map((m) => m.id)).not.toContain(embedded);
	expect(missingList.map((m) => m.id)).not.toContain(draft);
});

// ── Mutators ─────────────────────────────────────────────────────────────────

test("getGraphStats counts thoughts, edges and clusters", () => {
	const db = getDb();
	seedThought({ content: "active one" });
	seedThought({ content: "active two" });
	seedThought({ content: "a draft", status: "draft" });
	seedThought({ content: "an archive", status: "archived" });
	const cluster = seedThought({ content: "a cluster", is_cluster: 1 });
	seedEdge(cluster, seedThought({ content: "member" }), "cluster");

	const stats = getGraphStats(db);
	expect(stats.total_thoughts).toBe(6);
	expect(stats.total_edges).toBe(1);
	expect(stats.total_clusters).toBe(1);
	expect(stats.active).toBe(3); // member + active one + active two
	expect(stats.draft).toBe(1);
	expect(stats.archived).toBe(1);
});

test("deleteEdges deletes by id and returns the count", () => {
	const db = getDb();
	const a = seedThought({ content: "a" });
	const b = seedThought({ content: "b" });
	const keep = seedEdge(a, b, "related");
	const drop1 = seedEdge(a, b, "develops");
	const drop2 = seedEdge(b, a, "related");

	expect(deleteEdges(db, [drop1, drop2, crypto.randomUUID()])).toBe(2);
	expect(deleteEdges(db, [])).toBe(0);
	expect(deleteEdges(db, [keep])).toBe(1);
	expect(db.prepare(`SELECT COUNT(*) AS cnt FROM edges`).get()).toEqual({ cnt: 0 });
});

// ── deleteThoughts regression (#111): single-thought deletion path ──────────

test("deleteThoughts skips protected thoughts and cleans up vec rows + orphan tags", () => {
	const db = getDb();
	seedVecTable(db);
	const protectedId = seedThought({ content: "protected thought" }); // is_protected defaults to 1
	const doomed = seedThought({
		content: "doomed thought",
		is_protected: 0,
		tags: '["orphan-tag-unique"]',
	});
	seedVecRow(db, doomed);

	const deleted = deleteThoughts(db, [protectedId, doomed, crypto.randomUUID()]);

	expect(deleted).toBe(1);
	expect(
		db.prepare(`SELECT 1 FROM thoughts WHERE id = ?`).get(protectedId)
	).not.toBeNull();
	expect(
		db.prepare(`SELECT 1 FROM thoughts WHERE id = ?`).get(doomed)
	).toBeNull();
	// vec_thoughts cleanup happened inside the same deletion path
	expect(db.prepare(`SELECT 1 FROM vec_thoughts WHERE id = ?`).get(doomed)).toBeNull();
	// the doomed thought's tag had no other users → pruned
	expect(
		db.prepare(`SELECT 1 FROM tags WHERE name = ?`).get("orphan-tag-unique")
	).toBeNull();
});

test("deleteThoughts returns 0 for empty input", () => {
	const db = getDb();
	expect(deleteThoughts(db, [])).toBe(0);
});
