/**
 * Regression tests for audit-fix tasks #846 (SOLID/DRY/KISS) and #847
 * (centralized API error mapping).
 *
 * #846 — bulk route now uses typed BulkCreateItem[] (no `as never`), exported
 *        type is consumed by the route. Malformed thoughts values must still
 *        surface ValidationError → 400 via the global error handler.
 *
 * #847 — per-route try/catch blocks were removed from slots, crystals, tags,
 *        and projects. Domain errors must flow through the global errorHandler.
 *        Three previously uncovered paths:
 *          - slots PUT project-scope with missing project → 404
 *          - crystals POST with invalid input             → 400
 *          - tags PUT with missing id                     → 404
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { closeDb } from "../db/init";
import { createTestDb } from "../test/helpers";
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

// ── #846: bulk route typed input, malformed values → 400 ────────────────────

test("POST /api/thoughts/bulk with thoughts as a string yields 400", async () => {
	const res = await request("/api/thoughts/bulk", {
		method: "POST",
		body: JSON.stringify({ thoughts: "not-an-array" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.error).toBeString();
});

test("POST /api/thoughts/bulk with thoughts as null yields 400", async () => {
	const res = await request("/api/thoughts/bulk", {
		method: "POST",
		body: JSON.stringify({ thoughts: null }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("POST /api/thoughts/bulk with empty thoughts array yields 400", async () => {
	const res = await request("/api/thoughts/bulk", {
		method: "POST",
		body: JSON.stringify({ thoughts: [] }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

test("POST /api/thoughts/bulk with valid BulkCreateItem[] succeeds", async () => {
	const res = await request("/api/thoughts/bulk", {
		method: "POST",
		body: JSON.stringify({
			thoughts: [
				{ content: "first" },
				{ content: "second", tags: ["tag1"] },
			],
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.created).toBe(2);
	expect(body.errors).toBe(0);
});

test("POST /api/thoughts/bulk with partial failures reports per-item errors", async () => {
	// Invalid status on item 1; valid item 0.
	const res = await request("/api/thoughts/bulk", {
		method: "POST",
		body: JSON.stringify({
			thoughts: [
				{ content: "ok" },
				{ content: "bad", status: "bogus" as any },
			],
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.created).toBe(1);
	expect(body.errors).toBe(1);
	const details = body.error_details as Array<{ index: number; error: string }>;
	expect(details[0].index).toBe(1);
	expect(details[0].error).toBeString();
});

// ── #847: centralized error mapping — three previously uncovered paths ───────

test("PUT /api/slots project-scope with non-existent project yields 404", async () => {
	const res = await request("/api/slots/project_context", {
		method: "PUT",
		body: JSON.stringify({
			content: "scoped context",
			scope: "project",
			project_id: "does-not-exist",
		}),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(404);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.error).toBe("Project not found");
});

test("POST /api/crystals with invalid input yields 400", async () => {
	// No thought_ids and no cluster_id → ValidationError from crystallize().
	const res = await request("/api/crystals", {
		method: "POST",
		body: JSON.stringify({ style: "overview" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.error).toBeString();
});

test("PUT /api/tags/:id with missing id yields 404", async () => {
	const res = await request("/api/tags/nonexistent-tag-id", {
		method: "PUT",
		body: JSON.stringify({ name: "new-name" }),
		headers: { "Content-Type": "application/json" },
	});
	expect(res.status).toBe(404);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.error).toBeString();
});
