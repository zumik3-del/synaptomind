import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	deletePrimer,
	getPrimerByThoughtId,
	getPrimerIds,
	getPrimers,
	promoteThoughtToPrimer,
} from "./primers";
import { getThoughtImportance, incrementHitCount } from "./importance";

beforeEach(createTestDb);
afterEach(closeDb);

test("getPrimers returns empty when none exist", () => {
	expect(getPrimers(getDb())).toEqual([]);
});

test("promoteThoughtToPrimer creates a primer and boosts importance", () => {
	const db = getDb();
	const t = seedThought({ content: "key idea" });
	const primer = promoteThoughtToPrimer(db, t, 5);
	expect(primer).toBeDefined();
	expect(primer?.thought_id).toBe(t);
	expect(primer?.hit_count).toBe(5);
	expect(primer?.promoted_at).toBeDefined();

	const imp = getThoughtImportance(db, t);
	expect(imp?.importance).toBeCloseTo(1.0, 4);
});

test("promoteThoughtToPrimer updates hit_count on existing primer", () => {
	const db = getDb();
	const t = seedThought({ content: "key idea" });
	promoteThoughtToPrimer(db, t, 3);
	const before = getPrimerByThoughtId(db, t);
	expect(before?.hit_count).toBe(3);

	promoteThoughtToPrimer(db, t, 7);
	const after = getPrimerByThoughtId(db, t);
	expect(after?.hit_count).toBe(7);
});

test("getPrimerIds returns only primer thought ids", () => {
	const db = getDb();
	const t1 = seedThought({ content: "a" });
	const t2 = seedThought({ content: "b" });
	promoteThoughtToPrimer(db, t1, 5);

	const ids = getPrimerIds(db);
	expect(ids).toHaveLength(1);
	expect(ids).toContain(t1);
	expect(ids).not.toContain(t2);
});

test("deletePrimer removes the primer", () => {
	const db = getDb();
	const t = seedThought({ content: "a" });
	const primer = promoteThoughtToPrimer(db, t, 5);
	expect(primer).toBeDefined();

	const deleted = deletePrimer(db, primer?.id as string);
	expect(deleted).toBeTrue();
	expect(getPrimerByThoughtId(db, t)).toBeUndefined();
});

test("deletePrimer returns false for missing id", () => {
	expect(deletePrimer(getDb(), "nonexistent")).toBeFalse();
});

// ── the LIMIT clamp ───────────────────────────────────────────────────────────
// A negative LIMIT means "no limit" in SQLite and a fractional LIMIT bind is a
// datatype mismatch, so getPrimers clamps its limit to an integer >= 1: no call
// site can ask for an unbounded result set.

/** Three primers with descending hit counts. */
function seedThreePrimers(): { top: string; middle: string; low: string } {
	const db = getDb();
	const now = new Date().toISOString();
	const top = seedThought({ content: "top" });
	const middle = seedThought({ content: "middle" });
	const low = seedThought({ content: "low" });
	const insert = db.prepare("INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)");
	insert.run(top, 30, now);
	insert.run(middle, 20, now);
	insert.run(low, 10, now);
	return { top, middle, low };
}

test("getPrimers clamps a negative limit to exactly 1 row", () => {
	seedThreePrimers();

	const primers = getPrimers(getDb(), -1);

	expect(primers).toHaveLength(1);
	expect(primers[0]!.hit_count).toBe(30);
});

test("getPrimers clamps a zero limit to exactly 1 row", () => {
	seedThreePrimers();

	const primers = getPrimers(getDb(), 0);

	expect(primers).toHaveLength(1);
});

test("getPrimers floors a fractional limit", () => {
	seedThreePrimers();

	const primers = getPrimers(getDb(), 2.7);

	expect(primers).toHaveLength(2);
});

test("getPrimers keeps a valid limit untouched, most-hit first", () => {
	const { top, middle } = seedThreePrimers();

	const primers = getPrimers(getDb(), 2);

	expect(primers).toHaveLength(2);
	expect(primers[0]!.thought_id).toBe(top);
	expect(primers[1]!.thought_id).toBe(middle);
});

test("getPrimers with the default limit returns every seeded row", () => {
	seedThreePrimers();

	const primers = getPrimers(getDb());

	expect(primers).toHaveLength(3);
});

test("incrementHitCount + promoteThoughtToPrimer auto-promotes at threshold", () => {
	const db = getDb();
	const t = seedThought({ content: "frequently searched" });
	for (let i = 0; i < 5; i++) {
		incrementHitCount(db, t);
	}
	const imp = getThoughtImportance(db, t);
	expect(imp?.hit_count).toBe(5);

	const primer = promoteThoughtToPrimer(db, t, imp?.hit_count ?? 0);
	expect(primer).toBeDefined();
});
