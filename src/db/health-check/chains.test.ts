import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runHealthCheck } from "../../services/health-check.service";
import { createTestDb, seedEdge, seedThought } from "../../test/helpers";
import { getDb } from "../container";
import { closeDb } from "../init";
import { findBrokenParentChains, findCircularChains, findReplacesChains } from "./chains";

function replacesChainCount(): number {
	const report = runHealthCheck();
	const semantic = report.categories.find((c) => c.name === "semantic_consistency");
	return semantic!.checks.find((c) => c.name === "replaces_chains")!.count;
}

beforeEach(createTestDb);
afterEach(closeDb);

describe("findReplacesChains", () => {
	test("returns no chain for a single replaces edge A->B", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		seedEdge(a, b, "replaces");

		expect(findReplacesChains(db)).toEqual([]);
	});

	test("returns exactly one chain [A,B,C] for A->B->C", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		seedEdge(a, b, "replaces");
		seedEdge(b, c, "replaces");

		const chains = findReplacesChains(db);
		expect(chains).toHaveLength(1);
		expect(chains[0]!.chain).toEqual([a, b, c]);
	});

	test("returns no chain for multiple disjoint single edges", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		const d = seedThought({ content: "d" });
		seedEdge(a, b, "replaces");
		seedEdge(c, d, "replaces");

		expect(findReplacesChains(db)).toEqual([]);
	});

	test("returns no chain for a shared target (A->B, C->B)", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		seedEdge(a, b, "replaces");
		seedEdge(c, b, "replaces");

		expect(findReplacesChains(db)).toEqual([]);
	});

	test("returns exactly one chain for a longer path A->B->C->D", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		const d = seedThought({ content: "d" });
		seedEdge(a, b, "replaces");
		seedEdge(b, c, "replaces");
		seedEdge(c, d, "replaces");

		const chains = findReplacesChains(db);
		expect(chains).toHaveLength(1);
		expect(chains[0]!.chain).toEqual([a, b, c, d]);
	});
});

describe("health-check service aggregation (#127)", () => {
	test("one replaces edge yields replaces_chains count 0 through runHealthCheck", () => {
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		seedEdge(a, b, "replaces");

		expect(replacesChainCount()).toBe(0);
	});

	test("A->B->C yields replaces_chains count 1 through runHealthCheck", () => {
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		seedEdge(a, b, "replaces");
		seedEdge(b, c, "replaces");

		expect(replacesChainCount()).toBe(1);
	});
});

describe("no regression in sibling chain finders (#127)", () => {
	test("findCircularChains still detects a parent cycle", () => {
		const db = getDb();
		const a = seedThought({ content: "a" });
		const b = seedThought({ content: "b" });
		const c = seedThought({ content: "c" });
		seedEdge(a, b, "parent");
		seedEdge(b, c, "parent");
		seedEdge(c, a, "parent");

		const cycles = findCircularChains(db);
		expect(cycles).toHaveLength(1);
		expect(cycles[0]!.cycle.sort()).toEqual([a, b, c].sort());
	});

	test("findBrokenParentChains still detects active parent -> archived child", () => {
		const db = getDb();
		const a = seedThought({ content: "active parent" });
		const b = seedThought({ content: "archived child", status: "archived" });
		seedEdge(a, b, "parent");

		const broken = findBrokenParentChains(db);
		expect(broken).toHaveLength(1);
		expect(broken[0]!.edge_id).toBeDefined();
	});
});
