import { afterEach, beforeEach, expect, test } from "bun:test";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import {
	deleteThoughtUrlLink,
	deleteThoughtUrlLinksNotIn,
	extractLinkKeys,
	getThoughtUrlLinks,
	getThoughtUrlLinksForThoughts,
	pruneThoughtUrlLinks,
	upsertThoughtUrlLink,
} from "../db/thought_url_links";
import { createTestDb, seedThought } from "../test/helpers";

beforeEach(createTestDb);
afterEach(closeDb);

test("upsertThoughtUrlLink creates then updates in place", () => {
	const db = getDb();
	const id = seedThought();
	const first = upsertThoughtUrlLink(db, id, "k1", "https://a.com", "A", 0);
	expect(first.id).toBeString();
	expect(first.url).toBe("https://a.com");

	const second = upsertThoughtUrlLink(db, id, "k1", "https://b.com", "B", 1);
	expect(second.id).toBe(first.id);
	expect(second.url).toBe("https://b.com");

	expect(getThoughtUrlLinks(db, id)).toHaveLength(1);
});

test("getThoughtUrlLinks orders by sort_order then created_at", () => {
	const db = getDb();
	const id = seedThought();
	upsertThoughtUrlLink(db, id, "k2", "https://b.com", "B", 2);
	upsertThoughtUrlLink(db, id, "k1", "https://a.com", "A", 1);
	const links = getThoughtUrlLinks(db, id);
	expect(links.map((l) => l.key)).toEqual(["k1", "k2"]);
});

test("deleteThoughtUrlLink removes by thought_id + key", () => {
	const db = getDb();
	const id = seedThought();
	upsertThoughtUrlLink(db, id, "k1", "https://a.com", "A");
	expect(deleteThoughtUrlLink(db, id, "k1")).toBeTrue();
	expect(deleteThoughtUrlLink(db, id, "k1")).toBeFalse();
	expect(getThoughtUrlLinks(db, id)).toHaveLength(0);
});

test("deleteThoughtUrlLinksNotIn drops orphans only", () => {
	const db = getDb();
	const id = seedThought();
	upsertThoughtUrlLink(db, id, "keep", "https://a.com", "A");
	upsertThoughtUrlLink(db, id, "drop", "https://b.com", "B");
	const removed = deleteThoughtUrlLinksNotIn(db, id, ["keep"]);
	expect(removed).toBe(1);
	expect(getThoughtUrlLinks(db, id).map((l) => l.key)).toEqual(["keep"]);
});

test("extractLinkKeys parses [[key|label]] and [[key]]", () => {
	const content = "see [[k1|Label One]] and [[k2]] also #248 ref";
	expect(extractLinkKeys(content)).toEqual(["k1", "k2"]);
});

test("pruneThoughtUrlLinks keeps rows whose marker is in content, drops the rest", () => {
	const db = getDb();
	const id = seedThought();
	upsertThoughtUrlLink(db, id, "keep", "https://a.com", "A");
	upsertThoughtUrlLink(db, id, "drop", "https://b.com", "B");
	const removed = pruneThoughtUrlLinks(db, id, "see [[keep|Keep]] marker");
	expect(removed).toBe(1);
	expect(getThoughtUrlLinks(db, id).map((l) => l.key)).toEqual(["keep"]);
});

test("getThoughtUrlLinksForThoughts returns rows for many thoughts", () => {
	const db = getDb();
	const a = seedThought();
	const b = seedThought();
	upsertThoughtUrlLink(db, a, "ka", "https://a.com", "A");
	upsertThoughtUrlLink(db, a, "ka2", "https://a2.com", "A2", 2);
	upsertThoughtUrlLink(db, b, "kb", "https://b.com", "B");
	const rows = getThoughtUrlLinksForThoughts(db, [a, b]);
	const byId: Record<string, string[]> = {};
	for (const r of rows) {
		if (!byId[r.thought_id]) byId[r.thought_id] = [];
		byId[r.thought_id].push(r.key);
	}
	expect(byId[a]).toEqual(["ka", "ka2"]);
	expect(byId[b]).toEqual(["kb"]);
});

test("getThoughtUrlLinksForThoughts excludes unknown ids", () => {
	const db = getDb();
	const id = seedThought();
	upsertThoughtUrlLink(db, id, "k1", "https://a.com", "A");
	const rows = getThoughtUrlLinksForThoughts(db, [id, "no-such-thought"]);
	expect(rows).toHaveLength(1);
	expect(rows[0].thought_id).toBe(id);
});

test("getThoughtUrlLinksForThoughts returns [] for empty input", () => {
	expect(getThoughtUrlLinksForThoughts(getDb(), [])).toEqual([]);
});
