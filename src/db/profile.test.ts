import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	getProfileStats,
	getProfileThoughts,
	setLastSummaryRun,
} from "./profile";
import { createThought } from "./thoughts";

beforeEach(createTestDb);
afterEach(closeDb);

test("getProfileThoughts returns only non-archived profile thoughts", () => {
	const db = getDb();
	seedThought({ content: "plain" });
	const keep = seedThought({
		content: "profile keep",
		tags: JSON.stringify(["@profile"]),
		is_profile: 1,
	});
	seedThought({
		content: "profile archived",
		status: "archived",
		is_profile: 1,
	});

	const thoughts = getProfileThoughts(db);
	expect(thoughts).toHaveLength(1);
	expect(thoughts[0].id).toBe(keep);
	expect(thoughts[0].is_profile).toBe(1);
});

test("createThought stores is_profile flag", () => {
	const db = getDb();
	const t = createThought(db, {
		content: "persona material",
		is_profile: true,
	});
	expect(t.is_profile).toBe(1);
});

test("getProfileStats counts thoughts and top tags", () => {
	const db = getDb();
	seedThought({
		content: "a",
		tags: JSON.stringify(["@profile-style"]),
		is_profile: 1,
	});
	seedThought({
		content: "b",
		tags: JSON.stringify(["@profile-style"]),
		is_profile: 1,
	});
	seedThought({
		content: "c",
		tags: JSON.stringify(["@profile-focus"]),
		is_profile: 1,
	});

	setLastSummaryRun(db, "2026-08-25T00:00:00.000Z");
	const stats = getProfileStats(db);
	expect(stats.profile_thoughts).toBe(3);
	expect(stats.top_tags[0]).toEqual({ name: "@profile-style", count: 2 });
	expect(stats.last_summary_run).toBe("2026-08-25T00:00:00.000Z");
});
