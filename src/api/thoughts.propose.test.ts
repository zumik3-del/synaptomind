import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { getDb } from "../db/container";
import { closeDb } from "../db/init";
import { createTestDb, seedThought } from "../test/helpers";
import { createApp } from "./router";
import type { PlacementPlan } from "../services/placement/types";

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

// ── POST /api/thoughts/propose (task #951) ───────────────────────────────────

test("POST /api/thoughts/propose with thought_id returns a PlacementPlan", async () => {
	const id = seedThought({ content: "propose contract marker" });
	const res = await request("/api/thoughts/propose", {
		method: "POST",
		body: JSON.stringify({ thought_id: id }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as PlacementPlan;
	expect(body.thought_id).toBe(id);
	expect(typeof body.generated_at).toBe("string");
	expect(typeof body.degraded).toBe("boolean");
	expect(Array.isArray(body.edges)).toBe(true);
	expect(["keep", "link", "merge", "replaces+archive"]).toContain(body.lifecycle.action);
	expect(body.lifecycle.review_required).toBe(true);
	expect(Array.isArray(body.lifecycle.blocked_by)).toBe(true);
});

test("POST /api/thoughts/propose with content returns a draft plan", async () => {
	const res = await request("/api/thoughts/propose", {
		method: "POST",
		body: JSON.stringify({ content: "draft propose contract" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as PlacementPlan;
	expect(body.thought_id).toBe("(draft)");
	expect(body.lifecycle.action).toBe("keep"); // empty DB, no merge target
});

test("POST /api/thoughts/propose with unknown thought_id returns 404", async () => {
	const res = await request("/api/thoughts/propose", {
		method: "POST",
		body: JSON.stringify({ thought_id: "nonexistent-id" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(404);
	const body = (await res.json()) as { error: string };
	expect(body.error.toLowerCase()).toContain("not found");
});

test("POST /api/thoughts/propose with empty body returns 400", async () => {
	const res = await request("/api/thoughts/propose", {
		method: "POST",
		body: JSON.stringify({}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error.toLowerCase()).toContain("thoughtid");
});

// read-only assertion via route: propose never creates new thoughts/edges/clusters
test("POST /api/thoughts/propose is read-only: no mutable table changes", async () => {
	const db = getDb();
	seedThought({ content: "before-propose-a" });
	seedThought({ content: "before-propose-b" });
	seedThought({ content: "before-propose-c", is_cluster: 1 });

	const before = {
		thoughts: (db.prepare("SELECT COUNT(*) AS n FROM thoughts").get() as { n: number }).n,
		edges: (db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n,
		clusterEdges: (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type='cluster'").get() as { n: number }).n,
		archived: (db.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE status='archived'").get() as { n: number }).n,
	};

	// Call propose three times (existing thought, another existing, draft).
	for (const body of [
		{ thought_id: seedThought({ content: "propose ro-1" }) },
		{ thought_id: seedThought({ content: "propose ro-2" }) },
		{ content: "propose ro draft" },
	]) {
		const res = await request("/api/thoughts/propose", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
	}

	const after = {
		thoughts: (db.prepare("SELECT COUNT(*) AS n FROM thoughts").get() as { n: number }).n,
		edges: (db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n,
		clusterEdges: (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type='cluster'").get() as { n: number }).n,
		archived: (db.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE status='archived'").get() as { n: number }).n,
	};

	// Propose itself must not mutate; the seeded thoughts added inside the loop
	// are expected to change `thoughts` and `archived`, so compare only the
	// structural invariants that propose would change (edges, clusters).
	// The seed inside the loop adds 2 more thoughts → we assert the +2 delta.
	expect(after.thoughts).toBe(before.thoughts + 2);
	expect(after.edges).toBe(before.edges);
	expect(after.clusterEdges).toBe(before.clusterEdges);
	// No new archives created by propose (only the initial seed's archived count)
	expect(after.archived).toBe(before.archived);
});

test("POST /api/thoughts/propose writes telemetry row with action=read, toolName=propose_placement", async () => {
	// Verify via log DB that a propose call produces the correct telemetry row.
	const { closeLogDb, getLogDb } = await import("../logging");
	const { config } = await import("../config");
	const origPath = config.logDbPath;
	closeLogDb();
	config.logDbPath = ":memory:";

	try {
		const id = seedThought({ content: "telemetry propose marker" });
		const res = await request("/api/thoughts/propose", {
			method: "POST",
			body: JSON.stringify({ thought_id: id }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);

		const db = getLogDb();
		expect(db).toBeTruthy();
		const row = db!.query("SELECT action, tool_name FROM thought_telemetry ORDER BY rowid DESC LIMIT 1").get() as
			| { action: string; tool_name: string }
			| undefined;
		expect(row).toBeTruthy();
		expect(row!.action).toBe("read");
		expect(row!.tool_name).toBe("propose_placement");
	} finally {
		closeLogDb();
		config.logDbPath = origPath;
	}
});
