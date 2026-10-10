import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import { createEdge } from "./edges";
import { getClusterMembers, getClusterThought } from "./cluster-edges";
import { getDb } from "./container";
import { closeDb } from "./init";

beforeEach(createTestDb);
afterEach(closeDb);

test("getClusterThought returns the cluster row for a cluster thought", () => {
	const db = getDb();
	const clusterId = seedThought({ content: "my cluster", is_cluster: 1 });
	const row = getClusterThought(db, clusterId);
	expect(row).toBeDefined();
	expect(row?.id).toBe(clusterId);
	expect(row?.content).toBe("my cluster");
});

test("getClusterThought returns null for a non-cluster thought", () => {
	const regularId = seedThought({ content: "regular" });
	expect(getClusterThought(getDb(), regularId)).toBeNull();
});

test("getClusterThought returns null for missing id", () => {
	expect(getClusterThought(getDb(), "nonexistent")).toBeNull();
});

// ── getClusterMembers ────────────────────────────────────────────────────────

test("getClusterMembers excludes archived members", () => {
	const db = getDb();
	const cluster = seedThought({ is_cluster: 1 });
	const activeMember = seedThought({ status: "active" });
	const archivedMember = seedThought({ status: "archived" });
	createEdge(db, cluster, activeMember, "cluster");
	createEdge(db, cluster, archivedMember, "cluster");
	const members = getClusterMembers(db, cluster);
	expect(members).toHaveLength(1);
	expect(members[0].id).toBe(activeMember);
});
