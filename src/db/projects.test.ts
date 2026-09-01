import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	resolveDefaultProjectId,
	updateProject,
} from "./projects";

beforeEach(createTestDb);
afterEach(closeDb);

test("listProjects returns default project initially", () => {
	const projects = listProjects(getDb());
	expect(projects.length).toBeGreaterThanOrEqual(1);
	expect(projects.some((p) => p.name === "Default")).toBeTrue();
});

test("createProject creates and returns a project", () => {
	const db = getDb();
	const p = createProject(db, { name: "Test" });
	expect(p.name).toBe("Test");
	expect(p.thought_count).toBe(0);
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
	expect(getProject(getDb(), "nonexistent")).toBeUndefined();
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

test("deleteProject removes project", () => {
	const db = getDb();
	const p = createProject(db, { name: "To Delete" });
	expect(deleteProject(db, p.id)).toBeTrue();
	expect(getProject(db, p.id)).toBeUndefined();
});

test("deleteProject returns false for missing id", () => {
	expect(deleteProject(getDb(), "nonexistent")).toBeFalse();
});

test("deleteProject throws when deleting Default project", () => {
	const db = getDb();
	const defaultId = resolveDefaultProjectId(db);
	expect(() => deleteProject(db, defaultId)).toThrow("Cannot delete the Default project");
	expect(getProject(db, defaultId)).toBeDefined();
});

test("deleteProject moves thoughts to Default before deletion", () => {
	const db = getDb();
	const defaultId = resolveDefaultProjectId(db);
	const p = createProject(db, { name: "With Thoughts" });

	db.prepare(
		`INSERT INTO thoughts (id, content, status, project_id, is_cluster, is_profile, created_at, updated_at)
		 VALUES (?, 'test', 'active', ?, 0, 0, ?, ?)`
	).run("thought-1", p.id, new Date().toISOString(), new Date().toISOString());

	expect(deleteProject(db, p.id)).toBeTrue();

	const thought = db.prepare(`SELECT project_id FROM thoughts WHERE id = ?`).get("thought-1") as { project_id: string };
	expect(thought.project_id).toBe(defaultId);
});

test("resolveDefaultProjectId creates or returns default", () => {
	const db = getDb();
	const id = resolveDefaultProjectId(db);
	expect(id).toBeString();
	const p = getProject(db, id);
	expect(p?.name).toBe("Default");
});
