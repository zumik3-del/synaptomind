import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import {
	getThoughtUrlLinks,
	upsertThoughtUrlLink,
} from "../db/thought_url_links";
import { getThoughtById } from "../services/thoughts.service";
import { createTestDb, seedEdge, seedThought } from "../test/helpers";
import { createApp } from "./router";

const restartEmbedderMock = mock(() => {});

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	restartEmbedder: restartEmbedderMock,
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
});

test("GET /api/stats returns thought counts", async () => {
	seedThought({ content: "active one" });
	seedThought({ content: "active two" });
	seedThought({ content: "archived one", status: "archived" });
	seedThought({ content: "cluster", is_cluster: 1 });

	const res = await request("/api/stats");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.thoughts).toBe(4);
	expect(body.active_thoughts).toBe(3);
	expect(body.clusters).toBe(1);
	expect(typeof body.db_size_bytes).toBe("number");
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
	expect(getThoughtById(sourceId)?.status).toBe("archived");
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

// Settings routes
test("GET /api/thought-settings returns defaults", async () => {
	const res = await request("/api/thought-settings");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.softLimit).toBe(500);
	expect(body.hardLimit).toBe(600);
});

test("PATCH /api/thought-settings updates limits", async () => {
	const res = await request("/api/thought-settings", {
		method: "PATCH",
		body: JSON.stringify({ softLimit: 50, hardLimit: 100 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.softLimit).toBe(50);
	expect(body.hardLimit).toBe(100);

	const again = await request("/api/thought-settings");
	expect(await again.json()).toEqual({ softLimit: 50, hardLimit: 100 });
});

test("PATCH /api/thought-settings rejects invalid limits", async () => {
	const res = await request("/api/thought-settings", {
		method: "PATCH",
		body: JSON.stringify({ softLimit: 0, hardLimit: 100 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PATCH /api/thought-settings rejects hard <= soft", async () => {
	const res = await request("/api/thought-settings", {
		method: "PATCH",
		body: JSON.stringify({ softLimit: 100, hardLimit: 100 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PATCH /api/thought-settings rejects missing fields", async () => {
	const res = await request("/api/thought-settings", {
		method: "PATCH",
		body: JSON.stringify({ softLimit: 50 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PATCH /api/thought-settings rejects non-integer limits", async () => {
	const res = await request("/api/thought-settings", {
		method: "PATCH",
		body: JSON.stringify({ softLimit: 1.5, hardLimit: 100 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("GET /api/embedder-settings returns default precache", async () => {
	const res = await request("/api/embedder-settings");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ precache: false, idleTimeoutMs: 600000 });
});

test("PATCH /api/embedder-settings updates precache and restarts", async () => {
	restartEmbedderMock.mockClear();
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ precache: true }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ precache: true, idleTimeoutMs: 600000 });
	expect(restartEmbedderMock).toHaveBeenCalled();

	const again = await request("/api/embedder-settings");
	expect(await again.json()).toEqual({ precache: true, idleTimeoutMs: 600000 });
});

test("PATCH /api/embedder-settings with same value skips restart", async () => {
	await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ precache: true }),
		headers: { "Content-Type": "application/json" },
	});
	restartEmbedderMock.mockClear();
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ precache: true }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(restartEmbedderMock).not.toHaveBeenCalled();
});

test("PATCH /api/embedder-settings rejects non-boolean precache", async () => {
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ precache: "yes" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PATCH /api/embedder-settings toggling back to false restarts", async () => {
	await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ precache: true }),
		headers: { "Content-Type": "application/json" },
	});
	restartEmbedderMock.mockClear();
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ precache: false }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ precache: false, idleTimeoutMs: 600000 });
	expect(restartEmbedderMock).toHaveBeenCalled();
});

test("PATCH /api/embedder-settings updates idleTimeoutMs and restarts", async () => {
	restartEmbedderMock.mockClear();
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ idleTimeoutMs: 300000 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ precache: false, idleTimeoutMs: 300000 });
	expect(restartEmbedderMock).toHaveBeenCalled();

	const again = await request("/api/embedder-settings");
	expect(await again.json()).toEqual({
		precache: false,
		idleTimeoutMs: 300000,
	});
});

test("PATCH /api/embedder-settings with same idleTimeoutMs skips restart", async () => {
	await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ idleTimeoutMs: 300000 }),
		headers: { "Content-Type": "application/json" },
	});
	restartEmbedderMock.mockClear();
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ idleTimeoutMs: 300000 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	expect(restartEmbedderMock).not.toHaveBeenCalled();
});

test("PATCH /api/embedder-settings rejects idleTimeoutMs below minimum", async () => {
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({ idleTimeoutMs: 500 }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("PATCH /api/embedder-settings rejects empty body", async () => {
	const res = await request("/api/embedder-settings", {
		method: "PATCH",
		body: JSON.stringify({}),
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

test("POST /api/thought-verify/run returns ok", async () => {
	const res = await request("/api/thought-verify/run", { method: "POST" });
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.ok).toBe(true);
});

test("GET /api/primers returns empty list when no primers", async () => {
	const res = await request("/api/primers");
	expect(res.status).toBe(200);
	const body = (await res.json()) as Array<{ thought_id: string }>;
	expect(body).toEqual([]);
});

test("POST /api/auto-cluster/trigger with no candidates returns empty run", async () => {
	const res = await request("/api/auto-cluster/trigger", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.candidates).toBe(0);
	expect(body.groups).toEqual([]);
	expect(body.clusters_created).toBe(0);
});

test("POST /api/auto-cluster/trigger accepts body overrides", async () => {
	const res = await request("/api/auto-cluster/trigger", {
		method: "POST",
		body: JSON.stringify({
			min_age_days: 1,
			min_similarity: 0.5,
			min_members: 2,
			dry_run: true,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.dry_run).toBe(true);
});

test("GET /api/auto-cluster/status reflects last run", async () => {
	await request("/api/auto-cluster/trigger", {
		method: "POST",
		body: JSON.stringify({}),
	});
	const res = await request("/api/auto-cluster/status");
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		last_run: string | null;
		result: unknown;
	};
	expect(body.last_run).not.toBeNull();
	expect(body.result).not.toBeNull();
});

// Smart notes (issue #195)

function setThoughtAge(id: string, daysAgo: number): void {
	const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
	getDb()
		.prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`)
		.run(created, id);
}

test("GET /api/smart-notes returns empty when none", async () => {
	const res = await request("/api/smart-notes");
	expect(res.status).toBe(200);
	expect((await res.json()) as unknown[]).toEqual([]);
});

test("POST /api/smart-notes creates a smart note", async () => {
	const t = seedThought({ content: "dormant" });
	const res = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as {
		thought_id: string;
		surface_condition: { type: string };
	};
	expect(body.thought_id).toBe(t);
	expect(body.surface_condition.type).toBe("older_than_days");
});

test("POST /api/smart-notes returns 404 for missing thought", async () => {
	const res = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: "nope",
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(404);
});

test("POST /api/smart-notes returns 400 for invalid condition", async () => {
	const t = seedThought({ content: "dormant" });
	const res = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "bogus" },
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("POST /api/smart-notes returns 400 for cluster thought", async () => {
	const t = seedThought({ content: "cluster", is_cluster: 1 });
	const res = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "has_tag", tag: "todo" },
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("GET /api/smart-notes reports ready for satisfied condition", async () => {
	const t = seedThought({ content: "old" });
	setThoughtAge(t, 5);
	await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});
	const res = await request("/api/smart-notes");
	const body = (await res.json()) as Array<{
		ready: boolean;
		condition_hit: string | null;
	}>;
	expect(body).toHaveLength(1);
	expect(body[0].ready).toBe(true);
	expect(body[0].condition_hit).toBe("older_than_days:2");
});

test("POST /api/smart-notes/eval returns ready flags", async () => {
	const t = seedThought({ content: "old" });
	setThoughtAge(t, 5);
	await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});
	const res = await request("/api/smart-notes/eval", {
		method: "POST",
		body: JSON.stringify({}),
	});
	const body = (await res.json()) as Array<{
		thought_id: string;
		ready: boolean;
	}>;
	expect(body).toHaveLength(1);
	expect(body[0]).toMatchObject({ thought_id: t, ready: true });
});

test("POST /api/smart-notes/eval includes surface_condition (#239)", async () => {
	const t = seedThought({ content: "old" });
	setThoughtAge(t, 5);
	await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});
	const res = await request("/api/smart-notes/eval", {
		method: "POST",
		body: JSON.stringify({}),
	});
	const body = (await res.json()) as Array<{
		thought_id: string;
		ready: boolean;
		surface_condition: unknown;
	}>;
	expect(body).toHaveLength(1);
	expect(body[0]).toMatchObject({
		thought_id: t,
		ready: true,
		surface_condition: { type: "older_than_days", days: 2 },
	});
});

test("POST /api/smart-notes/awaken promotes only ready notes", async () => {
	const readyT = seedThought({ content: "old", status: "draft" });
	setThoughtAge(readyT, 5);
	await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: readyT,
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});

	const dormantT = seedThought({ content: "fresh", status: "draft" });
	await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: dormantT,
			surface_condition: { type: "older_than_days", days: 2 },
		}),
		headers: { "Content-Type": "application/json" },
	});

	const res = await request("/api/smart-notes/awaken", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		count: number;
		awakened: Array<{ thought_id: string; condition_hit: string }>;
	};
	expect(body.count).toBe(1);
	expect(body.awakened[0]).toMatchObject({
		thought_id: readyT,
		condition_hit: "older_than_days:2",
	});

	expect(getThoughtById(readyT)?.status).toBe("active");
	expect(getThoughtById(dormantT)?.status).toBe("draft");
});

test("POST /api/smart-notes/:id/promote consumes (deletes) the note", async () => {
	const t = seedThought({ content: "dormant", status: "draft" });
	const created = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "has_tag", tag: "todo" },
		}),
		headers: { "Content-Type": "application/json" },
	});
	const note = (await created.json()) as { id: string };
	await request(`/api/smart-notes/${note.id}/promote`, {
		method: "POST",
		body: JSON.stringify({}),
	});

	const list = await request("/api/smart-notes");
	const notes = (await list.json()) as Array<{ id: string }>;
	expect(notes.find((n) => n.id === note.id)).toBeUndefined();
});

test("POST /api/smart-notes/:id/promote activates the thought", async () => {
	const t = seedThought({ content: "dormant", status: "draft" });
	const created = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "has_tag", tag: "todo" },
		}),
		headers: { "Content-Type": "application/json" },
	});
	const note = (await created.json()) as { id: string };
	const res = await request(`/api/smart-notes/${note.id}/promote`, {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		ok: boolean;
		thought: { id: string; status: string };
	};
	expect(body.ok).toBe(true);
	expect(body.thought.status).toBe("active");
});

test("DELETE /api/smart-notes/:id deletes the note", async () => {
	const t = seedThought({ content: "dormant" });
	const created = await request("/api/smart-notes", {
		method: "POST",
		body: JSON.stringify({
			thought_id: t,
			surface_condition: { type: "has_tag", tag: "todo" },
		}),
		headers: { "Content-Type": "application/json" },
	});
	const note = (await created.json()) as { id: string };
	const res = await request(`/api/smart-notes/${note.id}`, {
		method: "DELETE",
	});
	expect(res.status).toBe(200);
	const list = await request("/api/smart-notes");
	expect((await list.json()) as unknown[]).toEqual([]);
});

test("DELETE /api/smart-notes/:id returns 404 for missing note", async () => {
	const res = await request("/api/smart-notes/nonexistent", {
		method: "DELETE",
	});
	expect(res.status).toBe(404);
});

// Profile routes (issue #200)

test("POST /api/thoughts accepts is_profile flag", async () => {
	const res = await request("/api/thoughts", {
		method: "POST",
		body: JSON.stringify({ content: "persona fact", is_profile: true }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.is_profile).toBe(1);

	const t = getThoughtById(String(body.id));
	expect(t?.is_profile).toBe(1);
});

test("PUT /api/thoughts/:id can set and clear is_profile", async () => {
	const id = seedThought({ content: "plain" });
	const setRes = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ is_profile: true }),
		headers: { "Content-Type": "application/json" },
	});
	expect(((await setRes.json()) as Record<string, unknown>).is_profile).toBe(1);

	const clearRes = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ is_profile: false }),
		headers: { "Content-Type": "application/json" },
	});
	expect(((await clearRes.json()) as Record<string, unknown>).is_profile).toBe(
		0,
	);
});

test("GET /api/profile/thoughts and /stats reflect profile thoughts", async () => {
	seedThought({
		content: "p1",
		tags: JSON.stringify(["@profile-style"]),
		is_profile: 1,
	});
	seedThought({ content: "regular" });

	const listRes = await request("/api/profile/thoughts");
	expect(listRes.status).toBe(200);
	const list = (await listRes.json()) as Record<string, unknown>[];
	expect(list).toHaveLength(1);
	expect(list[0].content).toBe("p1");

	const statsRes = await request("/api/profile/stats");
	const stats = (await statsRes.json()) as Record<string, unknown>;
	expect(stats.profile_thoughts).toBe(1);
	expect((stats.top_tags as Record<string, unknown>[])[0]?.name).toBe(
		"@profile-style",
	);
});

test("POST /api/profile/summarize creates summaries", async () => {
	seedThought({
		content: "one",
		tags: JSON.stringify(["@profile-style"]),
		is_profile: 1,
	});
	seedThought({
		content: "two",
		tags: JSON.stringify(["@profile-style"]),
		is_profile: 1,
	});

	const res = await request("/api/profile/summarize", { method: "POST" });
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	const created = body.created as Record<string, unknown>[];
	expect(created).toHaveLength(1);
	expect(created[0].topic).toBe("style");

	const list = (await (
		await request("/api/profile/thoughts")
	).json()) as Record<string, unknown>[];
	expect(list).toHaveLength(3);
});

test("PUT /api/thoughts/:id archive rejected for profile thought", async () => {
	const id = seedThought({ content: "persona", is_profile: 1 });
	const res = await request(`/api/thoughts/${id}`, {
		method: "PUT",
		body: JSON.stringify({ status: "archived" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

// Slots routes

test("GET /api/slots returns all five canonical slots", async () => {
	const res = await request("/api/slots");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { slots: Record<string, unknown>[] };
	expect(body.slots.map((s) => s.name)).toEqual([
		"persona",
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
			goals_delta: ["next step"],
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

test("GET /api/git-commits lists indexed commits", async () => {
	const res = await request("/api/git-commits");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { commits: unknown[]; total: number };
	expect(body.commits).toEqual([]);
	expect(body.total).toBe(0);
});
