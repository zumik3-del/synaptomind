import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import { getSlotRow, upsertSlot } from "./slots";

beforeEach(createTestDb);
afterEach(closeDb);

test("upsertSlot creates then updates the same row", () => {
	const db = getDb();
	const first = upsertSlot(db, {
		name: "active_goals",
		scope: "global",
		scope_id: null,
		content: "ship FI-17",
		max_chars: 2000,
	});
	const second = upsertSlot(db, {
		name: "active_goals",
		scope: "global",
		scope_id: null,
		content: "ship FI-18",
		max_chars: 2000,
	});

	expect(second.id).toBe(first.id);
	expect(second.content).toBe("ship FI-18");

	const rows = db.prepare(`SELECT COUNT(*) as c FROM slots`).get() as {
		c: number;
	};
	expect(rows.c).toBe(1);
});

test("same name can exist globally and per project", () => {
	const db = getDb();
	seedThought({ project_id: "proj-1" });
	upsertSlot(db, {
		name: "project_context",
		scope: "global",
		scope_id: null,
		content: "global ctx",
		max_chars: 2000,
	});
	upsertSlot(db, {
		name: "project_context",
		scope: "project",
		scope_id: "proj-1",
		content: "project ctx",
		max_chars: 2000,
	});

	expect(getSlotRow(db, "project_context", "global", null)?.content).toBe(
		"global ctx",
	);
	expect(getSlotRow(db, "project_context", "project", "proj-1")?.content).toBe(
		"project ctx",
	);
});

test("getSlotRow distinguishes NULL scope_id via COALESCE key", () => {
	const db = getDb();
	upsertSlot(db, {
		name: "active_goals",
		scope: "global",
		scope_id: null,
		content: "g",
		max_chars: 1000,
	});
	const found = getSlotRow(db, "active_goals", "global", null);
	expect(found).toBeDefined();
	expect(found?.max_chars).toBe(1000);
});
