import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, seedEdge, seedThought } from "../../test/helpers";
import { getDb } from "../container";
import { closeDb } from "../init";
import { runHealthCheck } from "../../services/health-check.service";
import {
	findContradictionInCluster,
	findContradictsRedundantWithReplaces,
	findContradictsToArchived,
	findContradictsWithHierarchy,
	findSupportsSelfConflict,
} from "./contradictions";

beforeEach(createTestDb);
afterEach(closeDb);

describe("findContradictsWithHierarchy", () => {
	test("flags a contradicts pair also connected by a direct parent edge", () => {
		const db = getDb();
		const parent = seedThought({ content: "parent claim" });
		const child = seedThought({ content: "child claim" });
		seedEdge(parent, child, "parent");
		seedEdge(child, parent, "contradicts");

		const found = findContradictsWithHierarchy(db);
		expect(found).toHaveLength(1);
		expect(new Set([found[0]!.source_id, found[0]!.target_id])).toEqual(
			new Set([parent, child]),
		);
	});

	test("flags a transitive hierarchy conflict (grandparent/develops chain)", () => {
		const db = getDb();
		const root = seedThought({ content: "root" });
		const mid = seedThought({ content: "mid" });
		const leaf = seedThought({ content: "leaf" });
		seedEdge(root, mid, "parent");
		seedEdge(mid, leaf, "develops");
		seedEdge(leaf, root, "contradicts");

		expect(findContradictsWithHierarchy(db)).toHaveLength(1);
	});

	test("does not flag a contradicts pair outside any hierarchy", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		seedEdge(a, b, "contradicts");
		expect(findContradictsWithHierarchy(db)).toEqual([]);
	});
});

describe("findContradictsRedundantWithReplaces", () => {
	test("flags a contradicts edge on the same pair as replaces (either direction)", () => {
		const db = getDb();
		const oldThought = seedThought({ content: "old" });
		const newThought = seedThought({ content: "new" });
		seedEdge(newThought, oldThought, "replaces");
		seedEdge(oldThought, newThought, "contradicts"); // junk: normally impossible

		const found = findContradictsRedundantWithReplaces(db);
		expect(found).toHaveLength(1);
		expect(found[0]!.replaces_edge_id).toBeDefined();
		expect(found[0]!.contradicts_edge_id).toBeDefined();
	});

	test("returns nothing when replaces and contradicts touch different pairs", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		seedEdge(a, b, "replaces");
		seedEdge(b, c, "contradicts");
		expect(findContradictsRedundantWithReplaces(db)).toEqual([]);
	});
});

describe("findContradictionInCluster", () => {
	test("flags two members of the same cluster that contradict each other", () => {
		const db = getDb();
		const cluster = seedThought({ content: "cluster", is_cluster: 1 });
		const m1 = seedThought({ content: "member one" });
		const m2 = seedThought({ content: "member two" });
		seedEdge(cluster, m1, "cluster");
		seedEdge(cluster, m2, "cluster");
		seedEdge(m1, m2, "contradicts");

		const found = findContradictionInCluster(db);
		expect(found).toHaveLength(1);
		expect(found[0]!.cluster_id).toBe(cluster);
		expect(new Set([found[0]!.member_a, found[0]!.member_b])).toEqual(
			new Set([m1, m2]),
		);
	});

	test("does not flag members of different clusters", () => {
		const db = getDb();
		const c1 = seedThought({ content: "cluster one", is_cluster: 1 });
		const c2 = seedThought({ content: "cluster two", is_cluster: 1 });
		const m1 = seedThought({ content: "member one" });
		const m2 = seedThought({ content: "member two" });
		seedEdge(c1, m1, "cluster");
		seedEdge(c2, m2, "cluster");
		seedEdge(m1, m2, "contradicts");
		expect(findContradictionInCluster(db)).toEqual([]);
	});
});

describe("findContradictsToArchived", () => {
	test("flags a contradicts edge whose endpoints are both archived", () => {
		const db = getDb();
		const a = seedThought({ content: "stale a", status: "archived" });
		const b = seedThought({ content: "stale b", status: "archived" });
		seedEdge(a, b, "contradicts");

		const found = findContradictsToArchived(db);
		expect(found).toHaveLength(1);
		expect(new Set([found[0]!.source_id, found[0]!.target_id])).toEqual(
			new Set([a, b]),
		);
	});

	test("does not flag when only one endpoint is archived", () => {
		const db = getDb();
		const archived = seedThought({ content: "archived", status: "archived" });
		const active = seedThought({ content: "active" });
		seedEdge(archived, active, "contradicts");
		expect(findContradictsToArchived(db)).toEqual([]);
	});
});

describe("findSupportsSelfConflict", () => {
	test("flags a pair carrying both supports and contradicts", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		seedEdge(a, b, "supports");
		seedEdge(b, a, "contradicts"); // junk: one-edge-per-pair should prevent it

		const found = findSupportsSelfConflict(db);
		expect(found).toHaveLength(1);
		expect(found[0]!.source_id).toBe(a);
		expect(found[0]!.target_id).toBe(b);
	});

	test("returns nothing for a lone supports edge", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		seedEdge(a, b, "supports");
		expect(findSupportsSelfConflict(db)).toEqual([]);
	});
});

describe("runHealthCheck semantic_consistency integration", () => {
	test("registers the new checks with the ADR severities", () => {
		const report = runHealthCheck();
		const semantic = report.categories.find(
			(c) => c.name === "semantic_consistency",
		);
		expect(semantic).toBeDefined();
		const check = (name: string) => semantic!.checks.find((c) => c.name === name)!;
		expect(check("contradicts_with_hierarchy").severity).toBe("warning");
		expect(check("contradiction_in_cluster").severity).toBe("warning");
		expect(check("contradicts_redundant_with_replaces").severity).toBe("info");
		expect(check("contradicts_to_archived").severity).toBe("info");
		expect(check("supports_self_conflict").severity).toBe("critical");
	});

	test("counts the seeded violations and feeds the health score", () => {
		const parent = seedThought({ content: "parent" });
		const child = seedThought({ content: "child" });
		seedEdge(parent, child, "parent");
		seedEdge(child, parent, "contradicts");

		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		seedEdge(a, b, "supports");
		seedEdge(a, b, "contradicts");

		const report = runHealthCheck();
		const semantic = report.categories.find(
			(c) => c.name === "semantic_consistency",
		)!;
		const counts = new Map(semantic.checks.map((c) => [c.name, c.count]));
		expect(counts.get("contradicts_with_hierarchy")).toBe(1);
		expect(counts.get("supports_self_conflict")).toBe(1);
		expect(report.summary.issues.critical).toBeGreaterThanOrEqual(1);
	});
});
