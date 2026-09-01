import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	updateProject,
} from "./projects";
import {
	archiveStaleLowImportance,
	archiveThought,
	batchGetImportance,
	boostImportance,
	createThought,
	decayImportance,
	getThought,
	getThoughtImportance,
	incrementHitCount,
	listThoughts,
	updateThought,
} from "./thoughts";

beforeEach(createTestDb);
afterEach(closeDb);

test("createThought inserts and returns a thought", () => {
	const db = getDb();
	const t = createThought(db, {
		content: "hello world",
		tags: ["tag1"],
		source: "test",
	});
	expect(t.id).toBeString();
	expect(t.content).toBe("hello world");
	expect(t.status).toBe("draft");
	expect(t.tags).toHaveLength(1);
	expect(t.tags[0].name).toBe("tag1");
	expect(t.source).toBe("test");
});

test("createThought without tags or source", () => {
	const db = getDb();
	const t = createThought(db, { content: "minimal" });
	expect(t.tags).toEqual([]);
	expect(t.source).toBeNull();
});

test("schema has no denormalized thoughts.tags column (issue #152)", () => {
	const db = getDb();
	const cols = (
		db.prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]
	).map((c) => c.name);
	expect(cols).not.toContain("tags");
	expect(cols).toContain("content");
});

test("getThought returns thought by id", () => {
	const db = getDb();
	const created = createThought(db, { content: "find me" });
	const found = getThought(db, created.id);
	expect(found).toBeDefined();
	expect(found?.content).toBe("find me");
});

test("getThought returns null for missing id", () => {
	const result = getThought(getDb(), "nonexistent");
	expect(result).toBeUndefined();
});

test("updateThought partial update: content only", () => {
	const db = getDb();
	const t = createThought(db, { content: "original" });
	const updated = updateThought(db, t.id, { content: "updated" });
	expect(updated?.content).toBe("updated");
	expect(updated?.status).toBe("draft");
});

test("updateThought partial update: status only", () => {
	const db = getDb();
	const t = createThought(db, { content: "original" });
	const updated = updateThought(db, t.id, { status: "active" });
	expect(updated?.status).toBe("active");
	expect(updated?.content).toBe("original");
});

test("updateThought partial update: tags only", () => {
	const db = getDb();
	const t = createThought(db, { content: "original" });
	const updated = updateThought(db, t.id, { tags: ["new", "tags"] });
	expect(updated?.tags.map((t) => t.name)).toEqual(["new", "tags"]);
});

test("updateThought returns null for missing id", () => {
	const updated = updateThought(getDb(), "nonexistent", { content: "x" });
	expect(updated).toBeUndefined();
});

test("archiveThought sets status to archived", () => {
	const db = getDb();
	const t = createThought(db, { content: "to archive" });
	const archived = archiveThought(db, t.id);
	expect(archived?.status).toBe("archived");
});

test("archiveThought returns null for missing id", () => {
	const result = archiveThought(getDb(), "nonexistent");
	expect(result).toBeUndefined();
});

test("listThoughts returns all thoughts", () => {
	const db = getDb();
	createThought(db, { content: "first" });
	createThought(db, { content: "second" });
	const all = listThoughts(db);
	expect(all).toHaveLength(2);
	expect(all.map((t) => t.content).sort()).toEqual(["first", "second"]);
});

test("listThoughts filters by status", () => {
	const db = getDb();
	createThought(db, { content: "draft one", status: "draft" });
	createThought(db, { content: "active one", status: "active" });
	createThought(db, { content: "active two", status: "active" });

	const drafts = listThoughts(db, { status: "draft" });
	expect(drafts).toHaveLength(1);

	const active = listThoughts(db, { status: "active" });
	expect(active).toHaveLength(2);
});

test('listThoughts treats status "all" as no filter', () => {
	const db = getDb();
	createThought(db, { content: "draft one", status: "draft" });
	createThought(db, { content: "active one", status: "active" });
	createThought(db, { content: "archived one", status: "archived" });

	const all = listThoughts(db, { status: "all" });
	expect(all).toHaveLength(3);
});

test("listThoughts respects limit and offset", () => {
	const db = getDb();
	for (let i = 0; i < 10; i++) {
		createThought(db, { content: `thought ${i}` });
	}

	const page1 = listThoughts(db, { limit: 3, offset: 0 });
	expect(page1).toHaveLength(3);

	const page2 = listThoughts(db, { limit: 3, offset: 3 });
	expect(page2).toHaveLength(3);
});

test("listThoughts returns empty when no thoughts match filter", () => {
	const result = listThoughts(getDb(), { status: "nonexistent" });
	expect(result).toHaveLength(0);
});

test("createThought with custom status and source", () => {
	const db = getDb();
	const t = createThought(db, {
		content: "custom",
		status: "active",
		source: "api",
		tags: ["a", "b"],
	});
	expect(t.status).toBe("active");
	expect(t.source).toBe("api");
	expect(t.tags.map((t) => t.name)).toEqual(["a", "b"]);
});

test("listThoughts filters by tag", () => {
	const db = getDb();
	createThought(db, { content: "ml stuff", tags: ["ml"] });
	createThought(db, { content: "nlp stuff", tags: ["nlp"] });
	createThought(db, { content: "both", tags: ["ml", "nlp"] });

	const ml = listThoughts(db, { tag: "ml" });
	expect(ml).toHaveLength(2);

	const nlp = listThoughts(db, { tag: "nlp" });
	expect(nlp).toHaveLength(2);
});

// Project tests
test("listProjects returns default project", () => {
	const projects = listProjects(getDb());
	expect(projects.length).toBeGreaterThanOrEqual(1);
	expect(projects[0].name).toBe("Default");
	expect(projects[0].thought_count).toBe(0);
	expect(projects[0].created_at).toBeString();
});

test("createProject creates and returns a project", () => {
	const db = getDb();
	const p = createProject(db, { name: "Test Project", description: "A test" });
	expect(p.id).toBeString();
	expect(p.name).toBe("Test Project");
	expect(p.description).toBe("A test");
	expect(p.thought_count).toBe(0);
	expect(p.created_at).toBeString();
});

test("createProject without description", () => {
	const db = getDb();
	const p = createProject(db, { name: "Minimal" });
	expect(p.name).toBe("Minimal");
	expect(p.description).toBeNull();
});

test("getProject returns project by id", () => {
	const db = getDb();
	const created = createProject(db, { name: "Findable" });
	const found = getProject(db, created.id);
	expect(found).toBeDefined();
	expect(found?.name).toBe("Findable");
});

test("getProject returns undefined for missing id", () => {
	const result = getProject(getDb(), "nonexistent");
	expect(result).toBeUndefined();
});

test("updateProject updates name", () => {
	const db = getDb();
	const p = createProject(db, { name: "Original" });
	updateProject(db, p.id, { name: "Renamed" });
	const updated = getProject(db, p.id);
	expect(updated?.name).toBe("Renamed");
});

test("updateProject clears description", () => {
	const db = getDb();
	const p = createProject(db, { name: "With Desc", description: "desc" });
	updateProject(db, p.id, { description: null });
	const updated = getProject(db, p.id);
	expect(updated?.description).toBeNull();
});

test("deleteProject removes project and reassigns thoughts", () => {
	const db = getDb();
	const p = createProject(db, { name: "To Delete" });
	const thought = createThought(db, {
		content: "in project",
		project_id: p.id,
	});
	expect(thought.project_id).toBe(p.id);

	const deleted = deleteProject(db, p.id);
	expect(deleted).toBeTrue();

	const afterDelete = getProject(db, p.id);
	expect(afterDelete).toBeUndefined();

	const reassigned = getThought(db, thought.id);
	expect(reassigned).toBeDefined();
	expect(reassigned?.project_id).not.toBe(p.id);
});

test("deleteProject returns false for missing id", () => {
	const result = deleteProject(getDb(), "nonexistent");
	expect(result).toBeFalse();
});

test("listProjects counts thoughts per project", () => {
	const db = getDb();
	const p = createProject(db, { name: "With Thoughts" });
	createThought(db, { content: "thought 1", project_id: p.id });
	createThought(db, { content: "thought 2", project_id: p.id });

	const projects = listProjects(db);
	const found = projects.find((pr) => pr.id === p.id);
	expect(found).toBeDefined();
	expect(found?.thought_count).toBe(2);
});

// thought_importance tests

test("creating a thought seeds a thought_importance row with importance 1.0", () => {
	const db = getDb();
	const t = createThought(db, { content: "new thought" });
	const imp = getThoughtImportance(db, t.id);
	expect(imp).toBeDefined();
	expect(imp?.importance).toBe(1.0);
	expect(imp?.hit_count).toBe(0);
});

test("boostImportance increases importance capped at 1.0", () => {
	const db = getDb();
	const t = createThought(db, { content: "boost me" });
	let imp = getThoughtImportance(db, t.id);
	expect(imp?.importance).toBe(1.0);

	boostImportance(db, t.id, 0.1);
	imp = getThoughtImportance(db, t.id);
	expect(imp?.importance).toBe(1.0);

	db.prepare(
		`UPDATE thought_importance SET importance = 0.5 WHERE thought_id = ?`,
	).run(t.id);
	imp = getThoughtImportance(db, t.id);
	expect(imp?.importance).toBe(0.5);

	boostImportance(db, t.id, 0.3);
	imp = getThoughtImportance(db, t.id);
	expect(imp?.importance).toBeCloseTo(0.8, 5);
});

test("incrementHitCount increases hit_count", () => {
	const db = getDb();
	const t = createThought(db, { content: "hit me" });
	let imp = getThoughtImportance(db, t.id);
	expect(imp?.hit_count).toBe(0);

	incrementHitCount(db, t.id);
	imp = getThoughtImportance(db, t.id);
	expect(imp?.hit_count).toBe(1);

	incrementHitCount(db, t.id);
	imp = getThoughtImportance(db, t.id);
	expect(imp?.hit_count).toBe(2);
});

test("batchGetImportance returns map for given ids", () => {
	const db = getDb();
	const t1 = createThought(db, { content: "first" });
	const t2 = createThought(db, { content: "second" });
	db.prepare(
		`UPDATE thought_importance SET importance = 0.7 WHERE thought_id = ?`,
	).run(t1.id);

	const map = batchGetImportance(db, [t1.id, t2.id]);
	expect(map.has(t1.id)).toBeTrue();
	expect(map.get(t1.id)?.importance).toBe(0.7);
	expect(map.get(t2.id)?.importance).toBe(1.0);
});

test("decayImportance multiplies by rate", () => {
	const db = getDb();
	const t = createThought(db, { content: "decaying" });
	const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
	db.prepare(
		`UPDATE thought_importance SET importance = 1.0, last_decay = ? WHERE thought_id = ?`,
	).run(twoDaysAgo, t.id);

	decayImportance(db, 0.9);
	const imp = getThoughtImportance(db, t.id);
	expect(imp?.importance).toBeCloseTo(0.9, 5);
});

test("decayImportance skips recent last_decay", () => {
	const db = getDb();
	const t = createThought(db, { content: "fresh" });
	const before = getThoughtImportance(db, t.id)?.importance;
	decayImportance(db, 0.5);
	const after = getThoughtImportance(db, t.id)?.importance;
	expect(after).toBe(before);
});

test("archiveStaleLowImportance archives old low-importance thoughts", () => {
	const db = getDb();
	const t = createThought(db, { content: "stale one", status: "active" });
	const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
	db.prepare(
		`UPDATE thoughts SET created_at = ?, updated_at = ? WHERE id = ?`,
	).run(sixtyDaysAgo, sixtyDaysAgo, t.id);
	db.prepare(
		`UPDATE thought_importance SET importance = 0.05, last_decay = ?, created_at = ? WHERE thought_id = ?`,
	).run(sixtyDaysAgo, sixtyDaysAgo, t.id);

	const archived = archiveStaleLowImportance(db, 0.1, 30);
	expect(archived).toBe(1);

	const after = getThought(db, t.id);
	expect(after?.status).toBe("archived");
});

test("archiveStaleLowImportance does not archive recent low-importance thoughts", () => {
	const db = getDb();
	const t = createThought(db, { content: "recently faded", status: "active" });
	db.prepare(
		`UPDATE thought_importance SET importance = 0.05 WHERE thought_id = ?`,
	).run(t.id);

	const archived = archiveStaleLowImportance(db, 0.1, 30);
	expect(archived).toBe(0);

	const after = getThought(db, t.id);
	expect(after?.status).toBe("active");
});
