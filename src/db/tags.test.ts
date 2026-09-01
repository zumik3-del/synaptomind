import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	createTag,
	deleteTag,
	findTagByName,
	getThoughtTags,
	listTags,
	pruneOrphanTags,
	renameTag,
	setThoughtTags,
} from "./tags";
import { createThought, deleteThought } from "./thoughts";

beforeEach(createTestDb);
afterEach(closeDb);

test("listTags returns empty initially", () => {
	expect(listTags(getDb())).toEqual([]);
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

test("renameTag updates tag name", () => {
	const db = getDb();
	const tag = createTag(db, "old-name");
	const renamed = renameTag(db, tag.id, "new-name");
	expect(renamed).toBeDefined();
	expect(renamed?.name).toBe("new-name");
});

test("renameTag returns undefined for missing id", () => {
	expect(renameTag(getDb(), "nonexistent", "x")).toBeUndefined();
});

test("deleteTag removes tag", () => {
	const db = getDb();
	const tag = createTag(db, "delete-me");
	expect(deleteTag(db, tag.id)).toBe(true);
	expect(findTagByName(db, "delete-me")).toBeUndefined();
});

test("deleteTag returns false for missing id", () => {
	expect(deleteTag(getDb(), "nonexistent")).toBe(false);
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

	expect(
		listTags(db)
			.map((t) => t.name)
			.sort(),
	).toEqual(["shared", "unique1", "unique2"]);

	setThoughtTags(db, t1.id, ["shared"]);
	const remaining = listTags(db)
		.map((t) => t.name)
		.sort();
	expect(remaining).toEqual(["shared", "unique2"]);
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
	expect(listTags(db)).toHaveLength(2);
	pruneOrphanTags(db);
	expect(listTags(db)).toHaveLength(0);
});

test("listTags filters by query", () => {
	const db = getDb();
	createTag(db, "machine learning");
	createTag(db, "deep learning");
	createTag(db, "computer vision");

	const results = listTags(db, "learning");
	expect(results.map((t) => t.name).sort()).toEqual([
		"deep learning",
		"machine learning",
	]);
});

test("listTags returns thought_count", () => {
	const db = getDb();
	const t1 = createThought(db, { content: "one" });
	const t2 = createThought(db, { content: "two" });

	setThoughtTags(db, t1.id, ["ml", "nlp"]);
	setThoughtTags(db, t2.id, ["ml"]);

	const tags = listTags(db);
	const mlTag = tags.find((t) => t.name === "ml");
	expect(mlTag?.thought_count).toBe(2);
	const nlpTag = tags.find((t) => t.name === "nlp");
	expect(nlpTag?.thought_count).toBe(1);
});

test("deleting a thought cleans up orphan tags", () => {
	const db = getDb();
	const t1 = createThought(db, { content: "one", tags: ["only-this"] });
	const _t2 = createThought(db, { content: "two", tags: ["shared"] });

	expect(findTagByName(db, "only-this")).toBeDefined();

	deleteThought(db, t1.id);
	expect(findTagByName(db, "only-this")).toBeUndefined();
	expect(findTagByName(db, "shared")).toBeDefined();
});
