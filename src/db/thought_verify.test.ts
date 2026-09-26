import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	createVerifyEntry,
	findThoughtsWithoutVerifyEntry,
	getFlaggedThoughtIds,
	getThoughtContentHash,
	getThoughtEmbedding,
	getVerifyEntries,
	getVerifyEntryByThoughtId,
	markFlagged,
	recordCheck,
	updateContentHash,
} from "./thought_verify";

beforeEach(createTestDb);
afterEach(closeDb);

test("getVerifyEntries returns empty when no entries", () => {
	expect(getVerifyEntries(getDb())).toEqual([]);
});

test("createVerifyEntry inserts a row", () => {
	const db = getDb();
	const t = seedThought({ content: "test thought" });
	createVerifyEntry(db, t);
	const entry = getVerifyEntryByThoughtId(db, t);
	expect(entry).toBeDefined();
	expect(entry?.flagged).toBe(0);
});

test("createVerifyEntry is idempotent for same thought", () => {
	const db = getDb();
	const t = seedThought({ content: "test" });
	createVerifyEntry(db, t);
	createVerifyEntry(db, t);
	const entries = getVerifyEntries(db);
	expect(entries.filter((e) => e.thought_id === t)).toHaveLength(1);
});

test("markFlagged sets flagged and distance", () => {
	const db = getDb();
	const t = seedThought({ content: "stale" });
	createVerifyEntry(db, t);
	markFlagged(db, t, 0.4);
	const entry = getVerifyEntryByThoughtId(db, t);
	expect(entry?.flagged).toBe(1);
	expect(entry?.last_distance).toBeCloseTo(0.4, 5);
});

test("markFlagged stores NULL distance when drift is undefined", () => {
	const db = getDb();
	const t = seedThought({ content: "stale without drift" });
	createVerifyEntry(db, t);
	markFlagged(db, t, null);
	const entry = getVerifyEntryByThoughtId(db, t);
	expect(entry?.flagged).toBe(1);
	expect(entry?.last_distance).toBeNull();
});

test("recordCheck clears the flag and stamps distance + last_checked", () => {
	const db = getDb();
	const t = seedThought({ content: "checked clean" });
	createVerifyEntry(db, t);
	markFlagged(db, t, 0.4);
	recordCheck(db, t, 0.1);
	const entry = getVerifyEntryByThoughtId(db, t);
	expect(entry?.flagged).toBe(0);
	expect(entry?.last_distance).toBeCloseTo(0.1, 5);
	expect(entry?.last_checked).not.toBeNull();
});

test("findThoughtsWithoutVerifyEntry returns embedded thoughts lacking an entry", () => {
	const db = getDb();
	db.prepare(
		`CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)`,
	).run();
	const insertVec = db.prepare(
		`INSERT OR REPLACE INTO vec_thoughts (id, embedding) VALUES (?, ?)`,
	);

	const noEntry = seedThought({ content: "embedded, not armed" });
	insertVec.run(noEntry, Buffer.alloc(0));
	const withEntry = seedThought({ content: "embedded and armed" });
	insertVec.run(withEntry, Buffer.alloc(0));
	createVerifyEntry(db, withEntry);
	const noVec = seedThought({ content: "never embedded" });

	const ids = findThoughtsWithoutVerifyEntry(db);
	expect(ids).toContain(noEntry);
	expect(ids).not.toContain(withEntry);
	expect(ids).not.toContain(noVec);
});

test("updateContentHash stores the hash", () => {
	const db = getDb();
	const t = seedThought({ content: "test" });
	createVerifyEntry(db, t);
	updateContentHash(db, t, "abc123");
	const entry = getVerifyEntryByThoughtId(db, t);
	expect(entry?.content_hash).toBe("abc123");
});

test("getFlaggedThoughtIds returns only flagged thoughts", () => {
	const db = getDb();
	const t1 = seedThought({ content: "flagged one" });
	const t2 = seedThought({ content: "clean one" });
	createVerifyEntry(db, t1);
	createVerifyEntry(db, t2);
	markFlagged(db, t1, 0.5);

	const flagged = getFlaggedThoughtIds(db);
	expect(flagged).toContain(t1);
	expect(flagged).not.toContain(t2);
});

test("getThoughtContentHash returns the hash stored in thoughts.content_hash", () => {
	const db = getDb();
	const t = seedThought({ content: "test content" });
	db.prepare(`UPDATE thoughts SET content_hash = 'sha256abc' WHERE id = ?`).run(t);
	expect(getThoughtContentHash(db, t)).toBe('sha256abc');
});

test("getThoughtContentHash returns null for missing thought", () => {
	expect(getThoughtContentHash(getDb(), 'nonexistent')).toBeNull();
});

test("getThoughtEmbedding returns Float32Array when vec_thoughts row exists", () => {
	const db = getDb();
	db.prepare(`CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)`).run();
	const t = seedThought({ content: "embedded" });
	const vec = new Float32Array([1, 2, 3]);
	db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(
		t,
		Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength),
	);
	const result = getThoughtEmbedding(db, t);
	expect(result).not.toBeNull();
	expect(result!.length).toBe(3);
	expect(result![0]).toBe(1);
	expect(result![1]).toBe(2);
	expect(result![2]).toBe(3);
});

test("getThoughtEmbedding returns null when vec_thoughts row is absent", () => {
	const t = seedThought({ content: "no embedding" });
	expect(getThoughtEmbedding(getDb(), t)).toBeNull();
});

test("getThoughtEmbedding returns null for missing thought id", () => {
	expect(getThoughtEmbedding(getDb(), 'nonexistent')).toBeNull();
});
