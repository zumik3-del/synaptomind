import { afterEach, beforeEach, expect, test } from "bun:test";
import { createEdge } from "../db/edges";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import { getThoughtRow } from "../db/thoughts";
import { createTestDb, seedThought } from "../test/helpers";
import { evalCondition } from "./smart_notes.service";

beforeEach(createTestDb);
afterEach(closeDb);

test("evalCondition has_edge_type recognises contradicts edges", () => {
	const db = getDb();
	const a = seedThought({ content: "claim a" });
	const b = seedThought({ content: "rival claim b" });
	createEdge(db, a, b, "contradicts");

	const thought = getThoughtRow(db, a)!;
	const result = evalCondition(
		thought,
		{ type: "has_edge_type", edge_type: "contradicts" },
		db,
	);
	expect(result.ready).toBe(true);
	expect(result.hit).toBe("has_edge_type:contradicts");
});

test("evalCondition has_edge_type recognises supports from either endpoint", () => {
	const db = getDb();
	const evidence = seedThought({ content: "evidence" });
	const claim = seedThought({ content: "claim" });
	createEdge(db, evidence, claim, "supports");

	const onTarget = evalCondition(
		getThoughtRow(db, claim)!,
		{ type: "has_edge_type", edge_type: "supports" },
		db,
	);
	expect(onTarget.ready).toBe(true);
	expect(onTarget.hit).toBe("has_edge_type:supports");
});

test("evalCondition has_edge_type is not ready when no such edge exists", () => {
	const db = getDb();
	const a = seedThought({ content: "lonely claim" });
	const b = seedThought({ content: "unrelated" });
	createEdge(db, a, b, "related");

	const result = evalCondition(
		getThoughtRow(db, a)!,
		{ type: "has_edge_type", edge_type: "contradicts" },
		db,
	);
	expect(result.ready).toBe(false);
	expect(result.hit).toBeNull();
});
