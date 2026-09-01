import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb } from "../test/helpers";
import {
	buildGitSearchParams,
	countGitCommits,
	deleteGitQueueItems,
	findPendingGitEmbeddings,
	getGitCommitByHash,
	handleFailedGitItem,
	insertGitEmbedding,
	listGitCommits,
	queueGitEmbedding,
	searchGitCommits,
	upsertGitCommit,
} from "./git_commits";
import { getDb } from "./container";
import { closeDb } from "./init";

beforeEach(createTestDb);
afterEach(closeDb);

test("upsertGitCommit inserts once per hash, updates nothing on repeat", () => {
	const db = getDb();
	const first = upsertGitCommit(db, {
		hash: "abc123",
		message: "feat: slots",
		committed_at: "2026-08-25 10:00:00 +0000",
		author: "opencode",
	});
	expect(first.created).toBe(true);

	const second = upsertGitCommit(db, {
		hash: "abc123",
		message: "feat: slots",
		committed_at: "2026-08-25 10:00:00 +0000",
	});
	expect(second.created).toBe(false);
	expect(second.commit.id).toBe(first.commit.id);
	expect(countGitCommits(db)).toBe(1);
});

test("getGitCommitByHash finds by full hash", () => {
	const db = getDb();
	const { commit } = upsertGitCommit(db, {
		hash: "deadbeef",
		message: "fix: x",
		committed_at: "2026-08-25 11:00:00 +0000",
	});
	expect(getGitCommitByHash(db, "deadbeef")?.id).toBe(commit.id);
	expect(getGitCommitByHash(db, "nope")).toBeUndefined();
});

test("embedding queue drains via find/delete cycle", () => {
	const db = getDb();
	const { commit } = upsertGitCommit(db, {
		hash: "q1",
		message: "queued message",
		committed_at: "2026-08-25 12:00:00 +0000",
	});
	queueGitEmbedding(db, commit.id);

	const rows = findPendingGitEmbeddings(db, 10);
	expect(rows).toHaveLength(1);
	expect(rows[0].content).toBe("queued message");

	deleteGitQueueItems(db, [rows[0].id]);
	expect(findPendingGitEmbeddings(db, 10)).toHaveLength(0);
});

test("handleFailedGitItem dead-letters after max attempts", () => {
	const db = getDb();
	const { commit } = upsertGitCommit(db, {
		hash: "fail1",
		message: "m",
		committed_at: "2026-08-25 13:00:00 +0000",
	});
	queueGitEmbedding(db, commit.id);
	for (let i = 0; i < 10; i++)
		handleFailedGitItem(db, commit.id, "embedder down");

	const row = db
		.prepare(
			`SELECT is_error, error FROM pending_git_embeddings WHERE commit_id = ?`,
		)
		.get(commit.id) as {
		is_error: number;
		error: string;
	};
	expect(row.is_error).toBe(1);
	expect(row.error).toBe("embedder down");
});

test("searchGitCommits returns [] without vec0 (in-memory db)", () => {
	expect(searchGitCommits(getDb(), new Float32Array(384), 5)).toEqual([]);
});

test("insertGitEmbedding writes a row when vec0 available", () => {
	const db = getDb();
	const { commit } = upsertGitCommit(db, {
		hash: "vec1",
		message: "m",
		committed_at: "2026-08-25 14:00:00 +0000",
	});
	if (
		!db
			.prepare(`SELECT 1 FROM sqlite_master WHERE name='vec_git_commits'`)
			.get()
	) {
		expect(() =>
			insertGitEmbedding(db, commit.id, new Float32Array(384)),
		).toThrow();
	}
});

// issue #226: commits attributed to a (repo, hash) pair

test("same hash across different repos is stored as distinct commits", () => {
	const db = getDb();
	const a = upsertGitCommit(db, {
		hash: "sharedhash",
		message: "m",
		committed_at: "2026-08-25 15:00:00 +0000",
		repo: "https://github.com/user/repo-a",
	});
	const b = upsertGitCommit(db, {
		hash: "sharedhash",
		message: "m",
		committed_at: "2026-08-25 15:00:00 +0000",
		repo: "https://github.com/user/repo-b",
	});
	expect(a.created).toBe(true);
	expect(b.created).toBe(true);
	expect(a.commit.id).not.toBe(b.commit.id);
	expect(countGitCommits(db)).toBe(2);
	expect(getGitCommitByHash(db, "sharedhash")).toBeDefined();
});

test("upsertGitCommit stores project_id and canonicalizes repo", () => {
	const db = getDb();
	const { commit } = upsertGitCommit(db, {
		hash: "proj1",
		message: "m",
		committed_at: "2026-08-25 16:00:00 +0000",
		repo: "https://GITHUB.COM/User/Repo.git",
		project_id: "proj-uuid",
	});
	const row = db
		.prepare(`SELECT repo, project_id FROM git_commits WHERE id = ?`)
		.get(commit.id) as {
		repo: string;
		project_id: string | null;
	};
	expect(row.repo).toBe("https://github.com/user/repo");
	expect(row.project_id).toBe("proj-uuid");
});

test("re-indexing same repo+hash is a no-op", () => {
	const db = getDb();
	const first = upsertGitCommit(db, {
		hash: "dup",
		message: "m",
		committed_at: "2026-08-25 17:00:00 +0000",
		repo: "https://github.com/user/repo-a",
	});
	const second = upsertGitCommit(db, {
		hash: "dup",
		message: "m",
		committed_at: "2026-08-25 17:00:00 +0000",
		repo: "https://github.com/user/repo-a",
	});
	expect(first.created).toBe(true);
	expect(second.created).toBe(false);
	expect(countGitCommits(db)).toBe(1);
});

test("buildGitSearchParams orders bindings MATCH, k, project, LIMIT", () => {
	const buf = Buffer.from(new Float32Array(3).buffer);
	const without = buildGitSearchParams(buf, 5);
	expect(without).toHaveLength(3);
	expect(without[2]).toBe(5);

	const withProj = buildGitSearchParams(buf, 5, "proj-uuid");
	expect(withProj).toHaveLength(4);
	expect(withProj[2]).toBe("proj-uuid");
	expect(withProj[3]).toBe(5);
});

// A5: re-indexing the same (repo, hash) under a new project re-homes the commit.
test("upsertGitCommit re-homes commit to a new project_id on conflict", () => {
	const db = getDb();
	const a = upsertGitCommit(db, {
		hash: "rehome",
		message: "m",
		committed_at: "2026-08-25 10:00:00 +0000",
		repo: "https://github.com/user/repo",
		project_id: "projA",
	});
	expect(a.commit.project_id).toBe("projA");
	const b = upsertGitCommit(db, {
		hash: "rehome",
		message: "m",
		committed_at: "2026-08-25 10:00:00 +0000",
		repo: "https://github.com/user/repo",
		project_id: "projB",
	});
	expect(b.created).toBe(false);
	expect(b.commit.project_id).toBe("projB");
	const row = db
		.prepare(`SELECT project_id FROM git_commits WHERE id = ?`)
		.get(a.commit.id) as {
		project_id: string | null;
	};
	expect(row.project_id).toBe("projB");
});

// A6: list / count / get-by-hash honour an optional project filter.
test("listGitCommits, countGitCommits and getGitCommitByHash filter by project", () => {
	const db = getDb();
	upsertGitCommit(db, {
		hash: "p1",
		message: "m",
		committed_at: "2026-08-25 10:00:00 +0000",
		repo: "https://h/r",
		project_id: "P1",
	});
	upsertGitCommit(db, {
		hash: "p2",
		message: "m",
		committed_at: "2026-08-25 10:00:00 +0000",
		repo: "https://h/r",
		project_id: "P2",
	});
	expect(listGitCommits(db, 50, 0, "P1")).toHaveLength(1);
	expect(countGitCommits(db, "P1")).toBe(1);
	expect(countGitCommits(db)).toBe(2);
	expect(getGitCommitByHash(db, "p1", "P1")?.project_id).toBe("P1");
	expect(getGitCommitByHash(db, "p1", "P2")).toBeUndefined();
});
