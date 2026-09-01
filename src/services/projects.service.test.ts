import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeDb } from "../db/init";
import { createTestDb } from "../test/helpers";
import { ValidationError } from "./errors";
import {
	createProjectService,
	deleteProjectService,
	getProjectService,
	listProjectsService,
	updateProjectService,
} from "./projects.service";

beforeEach(createTestDb);
afterEach(closeDb);

test("listProjectsService returns default project initially", () => {
	const projects = listProjectsService();
	expect(projects.length).toBeGreaterThanOrEqual(1);
	expect(projects.some((p) => p.name === "Default")).toBeTrue();
});

test("createProjectService creates project", () => {
	const p = createProjectService({ name: "test" });
	expect(p.name).toBe("test");
});

test("createProjectService throws on empty name", () => {
	expect(() => createProjectService({ name: "" })).toThrow(ValidationError);
});

test("getProjectService returns project", () => {
	const p = createProjectService({ name: "test" });
	const found = getProjectService(p.id);
	expect(found).not.toBeNull();
	expect(found?.name).toBe("test");
});

test("getProjectService returns null for missing", () => {
	expect(getProjectService("nonexistent")).toBeNull();
});

test("updateProjectService updates name", () => {
	const p = createProjectService({ name: "old" });
	updateProjectService(p.id, { name: "new" });
	const updated = getProjectService(p.id);
	expect(updated?.name).toBe("new");
});

test("deleteProjectService removes project", () => {
	const p = createProjectService({ name: "test" });
	expect(deleteProjectService(p.id)).toBeTrue();
	expect(getProjectService(p.id)).toBeNull();
});

test("deleteProjectService returns false for missing", () => {
	expect(deleteProjectService("nonexistent")).toBeFalse();
});

test("deleteProjectService throws when deleting Default", () => {
	const projects = listProjectsService();
	const defaultProject = projects.find(p => p.name === "Default");
	expect(defaultProject).toBeDefined();
	expect(() => deleteProjectService(defaultProject!.id)).toThrow("Cannot delete the Default project");
});

test("deleteProjectService moves thoughts to Default", () => {
	const { createThoughtWithUrlLinks } = require("./thoughts.service");
	const projects = listProjectsService();
	const defaultProject = projects.find(p => p.name === "Default");

	const p = createProjectService({ name: "Disposable" });
	const thought = createThoughtWithUrlLinks({ content: "test thought", project_id: p.id });

	expect(deleteProjectService(p.id)).toBeTrue();
	expect(getProjectService(p.id)).toBeNull();

	const updatedThought = require("./thoughts.service").getThoughtById(thought.id);
	expect(updatedThought?.project_id).toBe(defaultProject?.id);
});

test("createProjectService persists git fields", () => {
	const p = createProjectService({
		name: "gitproj",
		is_git_linked: true,
		git_repo_url: "https://github.com/user/repo",
		git_auto_sync: true,
		git_sync_interval_ms: 21600000,
	});
	expect(p.is_git_linked).toBeTruthy();
	expect(p.git_repo_url).toBe("https://github.com/user/repo");
	expect(p.git_auto_sync).toBeTruthy();
	expect(p.git_sync_interval_ms).toBe(21600000);
});

test("createProjectService requires repo url when git-linked", () => {
	expect(() =>
		createProjectService({
			name: "bad",
			is_git_linked: true,
			git_repo_url: "",
		}),
	).toThrow(ValidationError);
});

test("updateProjectService applies git fields", () => {
	const p = createProjectService({ name: "plain" });
	updateProjectService(p.id, {
		is_git_linked: true,
		git_repo_url: "https://github.com/user/repo",
	});
	const updated = getProjectService(p.id);
	expect(updated?.is_git_linked).toBeTruthy();
	expect(updated?.git_repo_url).toBe("https://github.com/user/repo");
});

test("updateProjectService without git fields does not clear them", () => {
	const p = createProjectService({
		name: "keep",
		is_git_linked: true,
		git_repo_url: "https://github.com/user/repo",
		git_auto_sync: true,
		git_sync_interval_ms: 21600000,
	});
	updateProjectService(p.id, { name: "keep-renamed" });
	const updated = getProjectService(p.id);
	expect(updated?.name).toBe("keep-renamed");
	expect(updated?.is_git_linked).toBeTruthy();
	expect(updated?.git_repo_url).toBe("https://github.com/user/repo");
	expect(updated?.git_auto_sync).toBeTruthy();
	expect(updated?.git_sync_interval_ms).toBe(21600000);
});
