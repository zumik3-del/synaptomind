import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import {
	getThoughtUrlLinks,
	upsertThoughtUrlLink,
} from "../db/thought_url_links";
import { getThoughtByIdService } from "../services/thoughts.service";
import { createTestDb, seedEdge, seedThought } from "../test/helpers";
import { createApp } from "./router";

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	isEmbedderReady: () => true,
}));

process.env.SYNAPTOMIND_SECRET = "test-token";
const app = createApp();

async function request(path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("Authorization", "Bearer test-token");
	return app.request(path, { ...init, headers });
}

beforeEach(createTestDb);
afterEach(closeDb);

test("GET /health returns ok", async () => {
	const res = await request("/health");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.status).toBe("ok");
	const checks = body.checks as Record<string, unknown>;
	expect(checks.database).toBe("ok");
	expect(["ok", "not ready", "failed"]).toContain(String(checks.embedder));
});

test("GET /health returns 503 degraded when database check fails (issue #107)", async () => {
	// No manual reopen needed: beforeEach(createTestDb) gives every test a
	// fresh DB, and afterEach(closeDb) tolerates an already-closed DB.
	closeDb();

	const res = await request("/health");
	expect(res.status).toBe(503);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.status).toBe("degraded");
	const checks = body.checks as Record<string, unknown>;
	expect(checks.database).toBeTruthy();
	expect(checks.database).not.toBe("ok");
	expect(["ok", "not ready", "failed"]).toContain(String(checks.embedder));
});

test("GET /health returns version", async () => {
	const res = await request("/health");
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.version).toBeString();
	expect(body.version).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
});

test("POST /api/thoughts creates a thought", async () => {
	const res = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({
			content: "my thought",
			tags: ["tag1"],
			source: "api",
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.content).toBe("my thought");
	expect(body.tags).toEqual([{ id: expect.any(String), name: "tag1" }]);
});

test("POST /api/thoughts with parent_id creates edge", async () => {
	const parentId = seedThought({ content: "parent" });
	const res = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({
			content: "child",
			parent_id: parentId,
			relation: "develops",
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
});

test("GET /api/thoughts/:id returns thought", async () => {
	const id = seedThought({ content: "findable" });
	const res = await request(`/api/thoughts/${id}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.content).toBe("findable");
});

test("GET /api/thoughts/:id returns 404 for missing", async () => {
	const res = await request("/api/thoughts/nonexistent");
	expect(res.status).toBe(404);
});

test("PUT /api/thoughts/:id updates thought", async () => {
	const id = seedThought({ content: "original" });
	const res = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ content: "updated" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.content).toBe("updated");
});

test("PUT /api/thoughts/:id with only project_id updates the thought (issue #76)", async () => {
	const id = seedThought({ content: "original" });
	const pRes = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "Issue76 Project" }),
		headers: { "Content-Type": "application/json" },
	});
	const project = (await pRes.json()) as Record<string, unknown>;

	const res = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ project_id: project.id }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.project_id).toBe(project.id);
	expect(body.content).toBe("original");
});

test("PUT /api/thoughts/:id returns 404 for missing", async () => {
	const res = await request("/api/thoughts/nonexistent", {
		method: "PUT",
		body: JSON.stringify({ content: "x" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(404);
});

test("PUT /api/thoughts/:id prunes url_links whose marker was removed (issue #256)", async () => {
	const db = getDb();
	const id = seedThought({ content: "see [[keep|K]] and [[drop|D]]" });
	upsertThoughtUrlLink(db, id, "keep", "https://a.com", "Keep");
	upsertThoughtUrlLink(db, id, "drop", "https://b.com", "Drop");

	const res = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ content: "see [[keep|K]]" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(getThoughtUrlLinks(db, id).map((l) => l.key)).toEqual(["keep"]);
});

test("PUT /api/thoughts/:id without content leaves url_links untouched (issue #256)", async () => {
	const db = getDb();
	const id = seedThought({ content: "see [[keep|K]]" });
	upsertThoughtUrlLink(db, id, "keep", "https://a.com", "Keep");

	const res = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ status: "active" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(getThoughtUrlLinks(db, id).map((l) => l.key)).toEqual(["keep"]);
});

test("DELETE /api/thoughts/:id archives thought", async () => {
	const id = seedThought({ content: "to delete" });
	const res = await request(`/api/thoughts/${id}`, { method: "DELETE" });
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.status).toBe("archived");
});

test("DELETE /api/thoughts/:id returns 404 for missing", async () => {
	const res = await request("/api/thoughts/nonexistent", {
		method: "DELETE",
	});
	expect(res.status).toBe(404);
});

test("GET /api/thoughts/timeline returns thoughts", async () => {
	seedThought({ content: "first" });
	seedThought({ content: "second" });
	const res = await request("/api/thoughts/timeline");
	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown[];
	expect(body).toHaveLength(2);
});

test("GET /api/thoughts/timeline with status filter", async () => {
	seedThought({ content: "draft one", status: "draft" });
	seedThought({ content: "active one", status: "active" });
	const res = await request("/api/thoughts/timeline?status=draft");
	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown[];
	expect(body).toHaveLength(1);
});

test("GET /api/thoughts/timeline with project_id filter", async () => {
	const pRes = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "Filtered Project" }),
		headers: { "Content-Type": "application/json" },
	});
	const project = (await pRes.json()) as Record<string, unknown>;

	await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "in project", project_id: project.id }),
		headers: { "Content-Type": "application/json" },
	});
	await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "not in project" }),
		headers: { "Content-Type": "application/json" },
	});

	const res = await request(
		`/api/thoughts/timeline?project_id=${project.id}`,
	);
	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown[];
	expect(body).toHaveLength(1);
	expect((body[0] as Record<string, unknown>).content).toBe("in project");
});

test("GET /api/thoughts/timeline with tag filter", async () => {
	seedThought({ content: "ml thought", tags: '["ml"]' });
	seedThought({ content: "nlp thought", tags: '["nlp"]' });
	const res = await request("/api/thoughts/timeline?tag=ml");
	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown[];
	expect(body).toHaveLength(1);
});

test("POST /api/thoughts/:id/link creates edge", async () => {
	const src = seedThought();
	const tgt = seedThought();
	const res = await request(`/api/thoughts/${src}/link`, {
		method: "POST",
		body: JSON.stringify({ target_id: tgt, type: "develops" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.source).toBe(src);
	expect(body.target).toBe(tgt);
});

test("POST /api/thoughts/:id/link returns 400 for missing target_id", async () => {
	const id = seedThought();
	const res = await request(`/api/thoughts/${id}/link`, {
		method: "POST",
		body: JSON.stringify({}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("POST /api/thoughts/:id/link returns 409 for conflicting directed edge (reverse)", async () => {
	const a = seedThought();
	const b = seedThought();
	await request(`/api/thoughts/${a}/link`, {
		method: "POST",
		body: JSON.stringify({ target_id: b, type: "develops" }),
		headers: { "Content-Type": "application/json" },
	});
	// Reverse direction with same directed type → EdgeConflictError → 409
	const res = await request(`/api/thoughts/${b}/link`, {
		method: "POST",
		body: JSON.stringify({ target_id: a, type: "develops" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(409);
});

test("POST /api/thoughts/:id/link returns 400 for invalid edge type", async () => {
	const a = seedThought();
	const b = seedThought();
	const res = await request(`/api/thoughts/${a}/link`, {
		method: "POST",
		body: JSON.stringify({ target_id: b, type: "bogus" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("DELETE /api/edges/:id removes edge", async () => {
	const src = seedThought();
	const tgt = seedThought();
	const edgeRes = await request(`/api/thoughts/${src}/link`, {
		method: "POST",
		body: JSON.stringify({ target_id: tgt }),
		headers: { "Content-Type": "application/json" },
	});
	const edge = (await edgeRes.json()) as Record<string, unknown>;
	const res = await request(`/api/edges/${edge.id}`, { method: "DELETE" });
	expect(res.status).toBe(200);
});

test("DELETE /api/edges/:id returns 404 for missing", async () => {
	const res = await request("/api/edges/nonexistent", { method: "DELETE" });
	expect(res.status).toBe(404);
});

test("GET /api/graph returns graph data", async () => {
	const a = seedThought({ content: "node a" });
	const b = seedThought({ content: "node b" });
	seedEdge(a, b, "develops");

	const res = await request("/api/graph");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.nodes as unknown[]).toHaveLength(2);
	expect(body.edges as unknown[]).toHaveLength(1);
});

test("GET /api/graph only includes active thoughts", async () => {
	seedThought({ content: "active", status: "active" });
	seedThought({ content: "draft", status: "draft", source: "api" });

	const res = await request("/api/graph");
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.nodes as unknown[]).toHaveLength(1);
});

test("GET /api/graph?status=all includes draft thoughts", async () => {
	seedThought({ content: "active", status: "active" });
	seedThought({ content: "draft", status: "draft", source: "api" });

	const res = await request("/api/graph?status=all");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.nodes as unknown[]).toHaveLength(2);
});

test("GET /api/graph?status=draft returns only drafts", async () => {
	seedThought({ content: "active", status: "active" });
	seedThought({ content: "draft", status: "draft", source: "api" });

	const res = await request("/api/graph?status=draft");
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.nodes as unknown[]).toHaveLength(1);
});

test("GET /api/graph with invalid status returns 400", async () => {
	const res = await request("/api/graph?status=bogus");
	expect(res.status).toBe(400);
});

// Cluster API tests
test("POST /api/cluster creates cluster", async () => {
	const m1 = seedThought({ content: "member1" });
	const m2 = seedThought({ content: "member2" });
	const res = await request("/api/cluster", {
		method: "POST",
		body: JSON.stringify({ thought_ids: [m1, m2], title: "test cluster" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect((body.cluster as Record<string, unknown>).is_cluster).toBe(1);
	expect(body.edges as unknown[]).toHaveLength(2);
});

test("POST /api/cluster requires thought_ids", async () => {
	const res = await request("/api/cluster", {
		method: "POST",
		body: JSON.stringify({}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/members/:id returns members", async () => {
	const m1 = seedThought();
	const m2 = seedThought();
	const clusterRes = await request("/api/cluster", {
		method: "POST",
		body: JSON.stringify({ thought_ids: [m1, m2], title: "cluster" }),
		headers: { "Content-Type": "application/json" },
	});
	const clusterData = (await clusterRes.json()) as Record<string, unknown>;
	const clusterId = (clusterData.cluster as Record<string, unknown>)
		.id as string;

	const res = await request(`/api/thoughts/members/${clusterId}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.members as unknown[]).toHaveLength(2);
});

test("GET /api/thoughts/members/:id returns 400 for non-cluster", async () => {
	const id = seedThought();
	const res = await request(`/api/thoughts/members/${id}`);
	expect(res.status).toBe(400);
});

// Tags API
test("GET /api/tags returns empty initially", async () => {
	const res = await request("/api/tags");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual([]);
});

test("GET /api/tags returns tags", async () => {
	await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "tagged thought", tags: ["ml", "nlp"] }),
		headers: { "Content-Type": "application/json" },
	});

	const res = await request("/api/tags");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Array<Record<string, unknown>>;
	expect(body).toHaveLength(2);
	const mlTag = body.find((t: Record<string, unknown>) => t.name === "ml");
	expect(mlTag?.thought_count).toBe(1);
});

test("GET /api/tags?q= filters", async () => {
	await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({
			content: "thought",
			tags: ["machine learning", "deep learning"],
		}),
		headers: { "Content-Type": "application/json" },
	});

	const res = await request("/api/tags?q=deep");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Array<Record<string, unknown>>;
	expect(body).toHaveLength(1);
	expect(body[0].name).toBe("deep learning");
});

test("PUT /api/tags/:id renames a tag", async () => {
	const thought = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "t", tags: ["old-name"] }),
		headers: { "Content-Type": "application/json" },
	});
	const thoughtBody = (await thought.json()) as Record<string, unknown>;
	const tagId = (thoughtBody.tags as Array<Record<string, unknown>>)[0].id;

	const res = await request(`/api/tags/${tagId}`, {
		method: "PUT",
		body: JSON.stringify({ name: "new-name" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.name).toBe("new-name");
});

test("PUT /api/tags/:id returns 400 for empty name", async () => {
	const res = await request("/api/tags/some-id", {
		method: "PUT",
		body: JSON.stringify({ name: "" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("DELETE /api/tags/:id removes a tag", async () => {
	const thought = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "t", tags: ["delete-me"] }),
		headers: { "Content-Type": "application/json" },
	});
	const thoughtBody = (await thought.json()) as Record<string, unknown>;
	const tagId = (thoughtBody.tags as Array<Record<string, unknown>>)[0].id;

	const res = await request(`/api/tags/${tagId}`, { method: "DELETE" });
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ success: true });

	const tagsRes = await request("/api/tags");
	expect(await tagsRes.json()).toEqual([]);
});

test("DELETE /api/tags/:id returns 404 for missing", async () => {
	const res = await request("/api/tags/nonexistent", { method: "DELETE" });
	expect(res.status).toBe(404);
});

// Project routes
test("GET /api/projects returns list with default project", async () => {
	const res = await request("/api/projects");
	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown[];
	expect(body.length).toBeGreaterThanOrEqual(1);
	expect((body[0] as Record<string, unknown>).name).toBe("Default");
	expect((body[0] as Record<string, unknown>).created_at).toBeString();
});

test("POST /api/projects creates a project", async () => {
	const res = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "My Project", description: "Desc" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.name).toBe("My Project");
	expect(body.description).toBe("Desc");
	expect(body.thought_count).toBe(0);
	expect(body.created_at).toBeString();
});

test("POST /api/projects requires name", async () => {
	const res = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ description: "no name" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("GET /api/projects/:id returns a project", async () => {
	const createRes = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "Findable" }),
		headers: { "Content-Type": "application/json" },
	});
	const created = (await createRes.json()) as Record<string, unknown>;

	const res = await request(`/api/projects/${created.id}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.name).toBe("Findable");
});

test("GET /api/projects/:id returns 404 for missing", async () => {
	const res = await request("/api/projects/nonexistent");
	expect(res.status).toBe(404);
});

test("PATCH /api/projects/:id updates a project", async () => {
	const createRes = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "Original" }),
		headers: { "Content-Type": "application/json" },
	});
	const created = (await createRes.json()) as Record<string, unknown>;

	const res = await request(`/api/projects/${created.id}`, {
		method: "PATCH",
		body: JSON.stringify({ name: "Renamed" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ success: true });
});

test("DELETE /api/projects/:id deletes a project", async () => {
	const createRes = await request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "To Delete" }),
		headers: { "Content-Type": "application/json" },
	});
	const created = (await createRes.json()) as Record<string, unknown>;

	const res = await request(`/api/projects/${created.id}`, {
		method: "DELETE",
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ success: true });
});

test("DELETE /api/projects/:id returns 404 for missing", async () => {
	const res = await request("/api/projects/nonexistent", {
		method: "DELETE",
	});
	expect(res.status).toBe(404);
});

// Merge route
test("POST /api/thoughts/:targetId/merge returns preview", async () => {
	const sourceId = seedThought({ content: "source thought", tags: '["src"]' });
	const targetId = seedThought({ content: "target thought" });
	const otherId = seedThought({ content: "other" });
	seedEdge(sourceId, otherId, "develops");

	const res = await request(`/api/thoughts/${targetId}/merge`, {
		method: "POST",
		body: JSON.stringify({ source_id: sourceId }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.mode).toBe("preview");
	const source = body.source as Record<string, unknown>;
	expect(source.content).toBe("source thought");
	expect((source.edges as unknown[]).length).toBe(1);
	expect((body.target as Record<string, unknown>).content).toBe(
		"target thought",
	);
});

test("POST /api/thoughts/:targetId/merge returns 404 for missing source", async () => {
	const targetId = seedThought({ content: "target thought" });
	const res = await request(`/api/thoughts/${targetId}/merge`, {
		method: "POST",
		body: JSON.stringify({ source_id: "nonexistent" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(404);
});

test("POST /api/thoughts/:targetId/merge executes and returns transfer counts", async () => {
	const sourceId = seedThought({ content: "source thought" });
	const targetId = seedThought({ content: "target thought" });
	const otherId = seedThought({ content: "other" });
	seedEdge(sourceId, otherId, "develops");

	const res = await request(`/api/thoughts/${targetId}/merge`, {
		method: "POST",
		body: JSON.stringify({
			source_id: sourceId,
			merged_content: "merged content",
			merged_tags: ["a"],
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect((body.target as Record<string, unknown>).content).toBe(
		"merged content",
	);
	expect(body.transferredEdges).toBe(1);
	expect(getThoughtByIdService(sourceId)?.status).toBe("archived");
});

test("POST /api/thoughts/:targetId/merge returns 400 when source equals target", async () => {
	const id = seedThought({ content: "same" });
	const res = await request(`/api/thoughts/${id}/merge`, {
		method: "POST",
		body: JSON.stringify({ source_id: id, merged_content: "x" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/links/batch returns sparse map for many thoughts", async () => {
	const db = getDb();
	const a = seedThought({ content: "with links" });
	const b = seedThought({ content: "with links too" });
	const c = seedThought({ content: "no links" });
	upsertThoughtUrlLink(db, a, "ka", "https://a.com", "A");
	upsertThoughtUrlLink(db, a, "kb", "https://b.com", "B", 2);
	upsertThoughtUrlLink(db, b, "kc", "https://c.com", "C");

	const res = await request(`/api/thoughts/links/batch?ids=${a},${b},${c}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, { key: string }[]>;
	expect(Object.keys(body).sort()).toEqual([a, b].sort());
	expect(body[a].map((l) => l.key)).toEqual(["ka", "kb"]);
	expect(body[b].map((l) => l.key)).toEqual(["kc"]);
});

test("GET /api/thoughts/links/batch returns 400 when ids missing", async () => {
	const res = await request("/api/thoughts/links/batch");
	expect(res.status).toBe(400);
});

test("POST /api/thoughts with parent_id creates edge and boosts source importance", async () => {
	const db = getDb();
	const parentId = seedThought({ content: "parent" });
	db.prepare(
		`UPDATE thought_importance SET importance = 0.5 WHERE thought_id = ?`,
	).run(parentId);

	const res = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({
			content: "child",
			parent_id: parentId,
			relation: "develops",
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);

	const imp = db
		.prepare(`SELECT importance FROM thought_importance WHERE thought_id = ?`)
		.get(parentId) as { importance: number } | undefined;
	expect(imp?.importance).toBeCloseTo(0.6, 5);
});

test("POST /api/thought-verify/run is retired", async () => {
	const res = await request("/api/thought-verify/run", { method: "POST" });
	expect(res.status).toBe(404);
});

for (const value of ["true", "false"]) {
	test(`GET /api/thoughts/search ignores the retired exclude_flagged=${value} key`, async () => {
		const res = await request(`/api/thoughts/search?q=marker&exclude_flagged=${value}`);
		expect(res.status).toBe(200);
	});
}

test("GET /api/thoughts/search still returns ordinary matching thoughts", async () => {
	const id = seedThought({ content: "RETIRE_SEARCH_MARKER unique result" });
	const res = await request("/api/thoughts/search?q=RETIRE_SEARCH_MARKER&hybrid=1&status=active");
	expect(res.status).toBe(200);
	const results = (await res.json()) as Array<{ thought: { id: string } }>;
	expect(results.map((result) => result.thought.id)).toContain(id);
});

test("GET /api/primers returns empty list when no primers", async () => {
	const res = await request("/api/primers");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Array<{ thought_id: string }>;
	expect(body).toEqual([]);
});

// Profile routes (issue #200) — retired: the surface is gone.

test("POST /api/thoughts rejects the retired is_profile flag", async () => {
	const res = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "persona fact", is_profile: true }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
	expect(((await res.json()) as Record<string, unknown>).error).toContain(
		"is_profile is retired",
	);
});

test("PUT /api/thoughts/:id rejects the retired is_profile flag", async () => {
	const id = seedThought({ content: "plain" });
	const res = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ is_profile: true }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
	expect(getThoughtByIdService(id)?.content).toBe("plain");
});

test("the retired profile endpoints are not mounted", async () => {
	for (const path of [
		"/api/profile/thoughts",
		"/api/profile/stats",
		"/api/profile/summarize",
	]) {
		const res = await request(path, { method: path.endsWith("summarize") ? "POST" : "GET" });
		expect(res.status).toBe(404);
	}
});

// Admin/duplicate endpoints retired by the pruning batch (task #1940): the
// settings, stats, auto-cluster admin and search-hints surfaces are gone — a
// clean removal, so they answer 404 and no shim keeps them alive.

test("the retired admin, settings, stats and hint endpoints are not mounted", async () => {
	for (const [method, path] of [
		["POST", "/api/auto-cluster/trigger"],
		["GET", "/api/auto-cluster/status"],
		["GET", "/api/thought-settings"],
		["GET", "/api/embedder-settings"],
		["GET", "/api/stats"],
		["GET", "/api/thoughts/search/hints"],
	] as const) {
		const res = await request(path, { method });
		expect(res.status).toBe(404);
	}
});

test("POST /api/thoughts/bulk ignores the retired is_profile field", async () => {
	// Bulk has no per-item schema layer (`thoughts: z.array(z.unknown())`), so
	// the retired flag is silently dropped instead of refusing the request.
	const res = await request("/api/thoughts/bulk", {
		method: "POST",
		body: JSON.stringify({
			thoughts: [
				{ content: "bulk plain" },
				{ content: "bulk with retired flag", is_profile: true },
			],
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as {
		created: number;
		thoughts: Array<{ id: string }>;
	};
	expect(body.created).toBe(2);
	expect(body.thoughts.map((thought) => getThoughtByIdService(thought.id)?.content)).toEqual([
		"bulk plain",
		"bulk with retired flag",
	]);
});

// Slots routes

test("GET /api/slots returns all four canonical slots", async () => {
	const res = await request("/api/slots");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { slots: Record<string, unknown>[] };
	expect(body.slots.map((s) => s.name)).toEqual([
		"pending_items",
		"architecture_decisions",
		"project_context",
		"active_goals",
	]);
});

test("PUT /api/slots/:name writes an explicit slot and GET reflects it", async () => {
	const put = await request("/api/slots/active_goals", {
		method: "PUT",
		body: JSON.stringify({ content: "ship FI-17" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(put.status).toBe(200);
	const putBody = (await put.json()) as Record<string, unknown>;
	expect(putBody.content).toBe("ship FI-17");
	expect(putBody.virtual).toBe(false);

	const get = await request("/api/slots?names=active_goals");
	const getBody = (await get.json()) as { slots: Record<string, unknown>[] };
	expect(getBody.slots).toHaveLength(1);
	expect(getBody.slots[0].content).toBe("ship FI-17");
});

test("PUT /api/slots/:name rejects virtual slots", async () => {
	const res = await request("/api/slots/pending_items", {
		method: "PUT",
		body: JSON.stringify({ content: "nope" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PUT /api/slots/:name rejects the retired persona slot", async () => {
	const res = await request("/api/slots/persona", {
		method: "PUT",
		body: JSON.stringify({ content: "nope" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PUT /api/slots project scope requires existing project", async () => {
	const missing = await request("/api/slots/project_context", {
		method: "PUT",
		body: JSON.stringify({ content: "x", scope: "project" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(missing.status).toBe(400);

	seedThought({ project_id: "proj-9" });
	const ok = await request("/api/slots/project_context?project_id=proj-9", {
		method: "PUT",
		body: JSON.stringify({
			content: "ctx",
			scope: "project",
			project_id: "proj-9",
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(ok.status).toBe(200);

	const get = await request(
		"/api/slots?project_id=proj-9&names=project_context",
	);
	const getBody = (await get.json()) as { slots: Record<string, unknown>[] };
	expect(getBody.slots[0].content).toBe("ctx");
	expect(getBody.slots[0].scope).toBe("project");
});

test("POST /api/slots/reflect folds session outcome into slots", async () => {
	const res = await request("/api/slots/reflect", {
		method: "POST",
		body: JSON.stringify({
			summary: "did the thing",
			goals_add: ["next step"],
			decisions: ["picked A"],
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		ok: boolean;
		applied: Record<string, unknown>;
	};
	expect(body.ok).toBe(true);
	expect(body.applied.summary_appended).toBe(true);
	expect(body.applied.goals_added).toBe(1);
	expect(body.applied.decisions_created).toBe(1);

	const empty = await request("/api/slots/reflect", {
		method: "POST",
		body: JSON.stringify({}),
		headers: { "Content-Type": "application/json" },
	});
	expect(empty.status).toBe(400);
});

test("POST /api/slots/reflect applies canonical goal add and remove semantics", async () => {
	const added = await request("/api/slots/reflect", {
		method: "POST",
		body: JSON.stringify({ goals_add: ["Ship alpha", "ship ALPHA", "Ship beta"] }),
		headers: { "Content-Type": "application/json" },
	});
	expect(added.status).toBe(200);
	const addedBody = (await added.json()) as { applied: { goals_added: number } };
	expect(addedBody.applied.goals_added).toBe(2);

	const removed = await request("/api/slots/reflect", {
		method: "POST",
		body: JSON.stringify({
			goals_add: ["Ship gamma"],
			goals_remove: ["ALPHA", "BETA"],
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(removed.status).toBe(200);
	const removedBody = (await removed.json()) as {
		applied: { goals_added: number; goals_removed: number };
	};
	expect(removedBody.applied.goals_removed).toBe(2);
	expect(removedBody.applied.goals_added).toBe(1);

	const slots = await request("/api/slots?names=active_goals");
	const slotBody = (await slots.json()) as { slots: Array<{ content: string }> };
	expect(slotBody.slots[0].content).toBe("Ship gamma");
});

test("POST /api/slots/reflect rejects blank goals and retired goals_delta with migration hint", async () => {
	for (const payload of [{ goals_add: ["  "] }, { goals_remove: [""] }]) {
		const invalid = await request("/api/slots/reflect", {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
		});
		expect(invalid.status).toBe(400);
	}

	const retired = await request("/api/slots/reflect", {
		method: "POST",
		body: JSON.stringify({ goals_delta: ["old goal"] }),
		headers: { "Content-Type": "application/json" },
	});
	expect(retired.status).toBe(400);
	expect(await retired.text()).toContain("goals_add / goals_remove");
});
