import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	createTag,
	findTagByName,
	getThoughtTags,
	pruneOrphanTags,
	setThoughtTags,
} from "./tags";
import { createThought, deleteThought } from "./thoughts";

// The tag *inventory* helpers (list/rename/delete) are gone with the HTTP tag
// routes (ADR 2026-10-26): tags are only ever set through a thought write and
// pruned when they lose their last thought. The orphan checks below therefore
// read the table directly instead of going through a removed export.
function storedTagNames(db: Database): string[] {
	return (db.prepare("SELECT name FROM tags ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
}

beforeEach(createTestDb);
afterEach(closeDb);

test("the tag table starts empty", () => {
	expect(storedTagNames(getDb())).toEqual([]);
});

test("createTag creates and returns a tag", () => {
	const tag = createTag(getDb(), "ml");
	expect(tag.id).toBeString();
	expect(tag.name).toBe("ml");
});

test("createTag is idempotent via COLLATE NOCASE", () => {
	const db = getDb();
	const a = createTag(db, "ML");
	const b = createTag(db, "ml");
	expect(a.id).toBe(b.id);
});

test("findTagByName finds tag case-insensitively", () => {
	const db = getDb();
	const created = createTag(db, "Research");
	const found = findTagByName(db, "research");
	expect(found).toBeDefined();
	expect(found?.id).toBe(created.id);
});

test("findTagByName returns undefined for missing", () => {
	expect(findTagByName(getDb(), "nonexistent")).toBeUndefined();
});

test("setThoughtTags replaces tags on a thought", () => {
	const db = getDb();
	const thought = createThought(db, { content: "test" });

	const tags1 = setThoughtTags(db, thought.id, ["a", "b"]);
	expect(tags1).toHaveLength(2);
	expect(tags1.map((t) => t.name).sort()).toEqual(["a", "b"]);

	const tags2 = setThoughtTags(db, thought.id, ["b", "c"]);
	expect(tags2).toHaveLength(2);
	expect(tags2.map((t) => t.name).sort()).toEqual(["b", "c"]);

	const got = getThoughtTags(db, thought.id);
	expect(got.map((t) => t.name).sort()).toEqual(["b", "c"]);
});

test("setThoughtTags prunes orphan tags", () => {
	const db = getDb();
	const t1 = createThought(db, { content: "one" });
	const t2 = createThought(db, { content: "two" });

	setThoughtTags(db, t1.id, ["shared", "unique1"]);
	setThoughtTags(db, t2.id, ["shared", "unique2"]);

	expect(storedTagNames(db)).toEqual(["shared", "unique1", "unique2"]);

	setThoughtTags(db, t1.id, ["shared"]);
	expect(storedTagNames(db)).toEqual(["shared", "unique2"]);
});

test("getThoughtTags returns tags for a thought", () => {
	const db = getDb();
	const thought = createThought(db, { content: "tagged", tags: ["x", "y"] });
	const tags = getThoughtTags(db, thought.id);
	expect(tags.map((t) => t.name).sort()).toEqual(["x", "y"]);
});

test("getThoughtTags returns empty for untagged thought", () => {
	const db = getDb();
	const thought = createThought(db, { content: "no tags" });
	expect(getThoughtTags(db, thought.id)).toEqual([]);
});

test("pruneOrphanTags removes unused tags", () => {
	const db = getDb();
	createTag(db, "orphan1");
	createTag(db, "orphan2");
	expect(storedTagNames(db)).toHaveLength(2);
	pruneOrphanTags(db);
	expect(storedTagNames(db)).toHaveLength(0);
});

test("deleting a thought cleans up orphan tags", () => {
	const db = getDb();
	const t1 = createThought(db, { content: "one", tags: ["only-this"] });
	createThought(db, { content: "two", tags: ["shared"] });

	expect(findTagByName(db, "only-this")).toBeDefined();

	deleteThought(db, t1.id);
	expect(findTagByName(db, "only-this")).toBeUndefined();
	expect(findTagByName(db, "shared")).toBeDefined();
});
