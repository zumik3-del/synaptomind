import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	createSmartNote,
	deleteSmartNote,
	getSmartNote,
	getSmartNoteByThoughtId,
	listSmartNotes,
	type SurfaceCondition,
	setSurfaceCheckedAt,
} from "./smart_notes";
import { deleteThought } from "./thoughts";

beforeEach(createTestDb);
afterEach(closeDb);

const COND: SurfaceCondition = { type: "older_than_days", days: 2 };

test("listSmartNotes returns empty when none", () => {
	expect(listSmartNotes(getDb())).toEqual([]);
});

test("createSmartNote inserts a row with parsed condition", () => {
	const db = getDb();
	const t = seedThought({ content: "dormant" });
	const note = createSmartNote(db, t, COND);
	expect(note.thought_id).toBe(t);
	expect(note.surface_condition).toEqual(COND);
	expect(note.surface_checked_at).toBeNull();

	const fetched = getSmartNote(db, note.id);
	expect(fetched?.surface_condition).toEqual(COND);
});

test("getSmartNoteByThoughtId finds by thought", () => {
	const db = getDb();
	const t = seedThought({ content: "x" });
	createSmartNote(db, t, COND);
	const note = getSmartNoteByThoughtId(db, t);
	expect(note?.thought_id).toBe(t);
});

test("deleteSmartNote removes the row", () => {
	const db = getDb();
	const t = seedThought({ content: "x" });
	const note = createSmartNote(db, t, COND);
	expect(deleteSmartNote(db, note.id)).toBe(true);
	expect(getSmartNote(db, note.id)).toBeUndefined();
	expect(deleteSmartNote(db, note.id)).toBe(false);
});

test("setSurfaceCheckedAt stamps the check time", () => {
	const db = getDb();
	const t = seedThought({ content: "x" });
	const note = createSmartNote(db, t, COND);
	expect(note.surface_checked_at).toBeNull();
	setSurfaceCheckedAt(db, note.id);
	expect(getSmartNote(db, note.id)?.surface_checked_at).toBeTruthy();
});

test("deleting a thought cascades and removes its smart note", () => {
	const db = getDb();
	const t = seedThought({ content: "x" });
	const note = createSmartNote(db, t, COND);
	deleteThought(db, t);
	expect(getSmartNote(db, note.id)).toBeUndefined();
});

test("raw row stores condition as JSON string", () => {
	const db = getDb();
	const t = seedThought({ content: "x" });
	const note = createSmartNote(db, t, COND);
	const row = db
		.prepare(`SELECT surface_condition FROM smart_notes WHERE id = ?`)
		.get(note.id) as {
		surface_condition: string;
	};
	expect(row.surface_condition).toBe(JSON.stringify(COND));
});
