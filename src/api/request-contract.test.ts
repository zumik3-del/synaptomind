/**
 * Regression tests for task #1758 (audit M8): the shared request contract and
 * malformed-JSON handling across the HTTP surface.
 *
 * Before #1758 `jsonBodyOrDefault` swallowed *any* unusable payload (malformed
 * JSON or a schema mismatch) and returned the default, and the write routes
 * called `c.req.json()` directly (a malformed body surfaced as an unhandled
 * error → 500); `GET /api/graph` and `/api/thoughts/timeline` silently clamped
 * out-of-range `limit` instead of rejecting it. Each test below is a red-proof
 * mutation: it fails against the pre-#1758 behaviour and passes after it.
 *
 *   - malformed body on a required-body route → 400 (was 500)
 *   - absent body on a required-body route   → 400 "Request body is required"
 *   - invalid status / out-of-range limit    → 400 (was a silent clamp/accept)
 *   - absent body on an optional-body route  → defaults preserved (not a 400)
 *   - malformed body on an optional-body route → 400 (was swallowed to defaults)
 *
 * #1787 (audit M8 follow-up) closed two holes the #1758 rewrite opened:
 *   - a JSON `null` literal body on an optional-body route reached the call
 *     site and dereferenced into a 500 (now treated as "no payload"); and
 *   - `GET /api/thoughts/timeline?offset=abc` slipped a NaN through to
 *     bun:sqlite (a datatype-mismatch 500) instead of a 400.
 *
 * #1783 (audit M8 residual) closed the last raw-body/limit paths the shared
 * contract missed:
 *   - `POST /api/thoughts/:targetId/merge` called `c.req.json()` directly
 *     (malformed body → 500; a missing `source_id` slipped through unvalidated);
 *   - `PUT /api/slots/:name` did the same (malformed body → 500); and
 *   - `GET /api/proposals?limit=` had no range check (0 / 1001 reached the
 *     service as-is instead of a typed 400), now bound to the same
 *     `proposalsLimitSchema` the `memory_review` tool advertises.
 *
 * The behaviour suite mounts the three routers directly: `createApp()` installs
 * the process-wide API rate-limit singleton (`src/middleware/rate-limit.ts`),
 * shared with every other `createApp()` in a `bun test` run, and this file's
 * request count would otherwise consume the 200/min quota of unrelated suites
 * (see `routes.test.ts` for the same setup). One `createApp()` request below
 * still proves the production mount path.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { closeDb } from "../db/init";
import { createTestDb, seedThought } from "../test/helpers";
import { createApp } from "./router";
import { errorHandler } from "./error-handler";
import { graphRouter } from "./graph";
import { proposalsRouter } from "./proposals";
import { slotsRouter } from "./slots";
import { thoughtsRouter } from "./thoughts";

const restartEmbedderMock = mock(() => {});

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	restartEmbedder: restartEmbedderMock,
	isEmbedderReady: () => true,
}));

process.env.SYNAPTOMIND_SECRET = "test-token";

// Bare app: error-handler wiring is required for the ValidationError → 400
// mapping under test; the routers are mounted at their production prefixes.
const app = new Hono();
app.onError(errorHandler);
app.route("/api/thoughts", thoughtsRouter);
app.route("/api", graphRouter);
app.route("/api/proposals", proposalsRouter);
app.route("/api/slots", slotsRouter);

async function request(path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("Authorization", "Bearer test-token");
	return app.request(path, { ...init, headers });
}

/** Send a raw (possibly malformed) JSON body to a route. */
function postJson(path: string, body: string, method = "POST"): Promise<Response> {
	return request(path, {
		method,
		body,
		headers: { "Content-Type": "application/json" },
	});
}

async function errorOf(res: Response): Promise<string> {
	const body = (await res.json()) as Record<string, unknown>;
	return String(body.error);
}

beforeEach(createTestDb);
afterEach(closeDb);

// ── Production wiring (single request: shared rate-limit quota is scarce) ────

test("the production app maps a malformed body to 400", async () => {
	const production = createApp();
	const res = await production.request("/api/thoughts", {
		method: "POST",
		body: "{ not json",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
	});
	expect(res.status).toBe(400);
});

// ── Malformed body on a required-body route → 400 ───────────────────────────

test("POST /api/thoughts with malformed JSON yields 400", async () => {
	const res = await postJson("/api/thoughts", "{ not json");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

test("POST /api/thoughts/bulk with malformed JSON yields 400", async () => {
	const res = await postJson("/api/thoughts/bulk", "{ not json");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

test("PUT /api/thoughts/:id with malformed JSON yields 400", async () => {
	const id = seedThought({ content: "original" });
	const res = await postJson(`/api/thoughts/${id}`, "{ not json", "PUT");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

// ── Absent body on a required-body route → 400 ──────────────────────────────

test("POST /api/thoughts with no body yields 400", async () => {
	const res = await request("/api/thoughts", { method: "POST" });
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Request body is required");
});

test("PUT /api/thoughts/:id with no body yields 400", async () => {
	const id = seedThought({ content: "original" });
	const res = await request(`/api/thoughts/${id}`, { method: "PUT" });
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Request body is required");
});

// ── Schema mismatch on a required-body route → 400 ──────────────────────────

test("POST /api/thoughts with empty object yields 400 (content required)", async () => {
	const res = await postJson("/api/thoughts", JSON.stringify({}));
	expect(res.status).toBe(400);
});

test("POST /api/thoughts with empty content yields 400", async () => {
	const res = await postJson("/api/thoughts", JSON.stringify({ content: "" }));
	expect(res.status).toBe(400);
});

test("POST /api/thoughts with invalid status yields 400", async () => {
	const res = await postJson("/api/thoughts", JSON.stringify({ content: "x", status: "bogus" }));
	expect(res.status).toBe(400);
});

test("PUT /api/thoughts/:id with invalid status yields 400", async () => {
	const id = seedThought({ content: "original" });
	const res = await postJson(`/api/thoughts/${id}`, JSON.stringify({ status: "bogus" }), "PUT");
	expect(res.status).toBe(400);
});

// ── Optional-body routes: absent body keeps defaults, malformed still 400 ───

test("POST /api/thoughts/propose with malformed JSON yields 400", async () => {
	const res = await postJson("/api/thoughts/propose", "{ not json");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

test("POST /api/proposals/rollback with no body keeps defaults (reaches the service)", async () => {
	// No body ⇒ defaults ({}); the route then rejects the missing run_id itself.
	// A "Request body is required" here would mean the optional-body contract broke.
	const res = await request("/api/proposals/rollback", { method: "POST" });
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toBe("run_id is required");
});

test("POST /api/proposals/rollback with malformed JSON yields 400 (not swallowed)", async () => {
	const res = await postJson("/api/proposals/rollback", "{ not json");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

// ── GET /api/graph: invalid status and out-of-range limit → 400 ─────────────

test("GET /api/graph with invalid status yields 400", async () => {
	const res = await request("/api/graph?status=bogus");
	expect(res.status).toBe(400);
});

test("GET /api/graph with limit above 2000 yields 400 (was clamped)", async () => {
	const res = await request("/api/graph?limit=9999");
	expect(res.status).toBe(400);
});

test("GET /api/graph with limit below 1 yields 400 (was clamped)", async () => {
	const res = await request("/api/graph?limit=0");
	expect(res.status).toBe(400);
});

test("GET /api/graph with a valid limit still succeeds", async () => {
	seedThought({ content: "node a" });
	const res = await request("/api/graph?limit=50");
	expect(res.status).toBe(200);
});

// ── GET /api/thoughts/timeline: invalid status and limit>500 → 400 ──────────

test("GET /api/thoughts/timeline with invalid status yields 400", async () => {
	const res = await request("/api/thoughts/timeline?status=bogus");
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/timeline with limit above 500 yields 400 (was accepted)", async () => {
	const res = await request("/api/thoughts/timeline?limit=501");
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/timeline with limit 500 still succeeds", async () => {
	const res = await request("/api/thoughts/timeline?limit=500");
	expect(res.status).toBe(200);
});

// ── #1787: JSON `null` body on an optional-body route keeps defaults ────────
//
// A literal `null` payload must read as "no payload" (defaults applied), the
// same as an absent body — not dereference into a 500. Both red-prove against
// the #1758 code, where `jsonBodyOrDefault` returned the bare `null`.

test("POST /api/thoughts/propose with a JSON null body keeps defaults (was 500)", async () => {
	// A literal `null` payload must read as "no payload" (defaults applied), the
	// same as an absent body — not dereference into a 500. The route then
	// rejects the missing thought_id/content itself with a 400.
	const res = await postJson("/api/thoughts/propose", "null");
	expect(res.status).toBe(400);
});

test("POST /api/proposals/rollback with a JSON null body keeps defaults (was 500)", async () => {
	// Defaults ({}) reach the route, which then rejects the missing run_id
	// itself; a 500 would mean the null body dereferenced the default.
	const res = await postJson("/api/proposals/rollback", "null");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toBe("run_id is required");
});

// ── #1787: GET /api/thoughts/timeline offset is validated ───────────────────
//
// A non-numeric offset used to coerce to NaN and reach bun:sqlite, whose
// datatype mismatch surfaced as a 500; it must be a 400.

test("GET /api/thoughts/timeline with a non-numeric offset yields 400 (was 500)", async () => {
	const res = await request("/api/thoughts/timeline?offset=abc");
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/timeline with a negative offset yields 400", async () => {
	const res = await request("/api/thoughts/timeline?offset=-1");
	expect(res.status).toBe(400);
});

test("GET /api/thoughts/timeline with offset 0 still succeeds", async () => {
	const res = await request("/api/thoughts/timeline?offset=0");
	expect(res.status).toBe(200);
});

// ── #1783: POST /api/thoughts/:targetId/merge request body ──────────────────
//
// The merge route used raw `c.req.json()`: a malformed payload surfaced as an
// unhandled `SyntaxError` → 500 and an absent/empty `source_id` was never
// validated. It now shares `requiredJsonBody(mergeBodySchema)` with the rest of
// the surface.

test("POST /api/thoughts/:targetId/merge with malformed JSON yields 400 (was 500)", async () => {
	const targetId = seedThought({ content: "target" });
	const res = await postJson(`/api/thoughts/${targetId}/merge`, "{ not json");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

test("POST /api/thoughts/:targetId/merge with no body yields 400", async () => {
	const targetId = seedThought({ content: "target" });
	const res = await request(`/api/thoughts/${targetId}/merge`, { method: "POST" });
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Request body is required");
});

test("POST /api/thoughts/:targetId/merge without source_id yields 400 (was unvalidated)", async () => {
	const targetId = seedThought({ content: "target" });
	const res = await postJson(`/api/thoughts/${targetId}/merge`, JSON.stringify({}));
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toBeString();
});

test("POST /api/thoughts/:targetId/merge with a valid body still succeeds", async () => {
	const sourceId = seedThought({ content: "source" });
	const targetId = seedThought({ content: "target" });
	const res = await postJson(`/api/thoughts/${targetId}/merge`, JSON.stringify({ source_id: sourceId }));
	expect(res.status).toBe(200);
	expect(((await res.json()) as Record<string, unknown>).mode).toBe("preview");
});

// ── #1783: PUT /api/slots/:name request body ────────────────────────────────
//
// The slot route also used raw `c.req.json()`; malformed JSON was a 500, while
// an absent body must keep working via the `{}` default.

test("PUT /api/slots/:name with malformed JSON yields 400 (was 500)", async () => {
	const res = await postJson("/api/slots/project_context", "{ not json", "PUT");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toContain("Malformed JSON");
});

test("PUT /api/slots/:name with no body keeps the empty-content default", async () => {
	const res = await request("/api/slots/project_context", { method: "PUT" });
	expect(res.status).toBe(200);
});

test("PUT /api/slots/:name with a JSON null body keeps the default (not a 500)", async () => {
	const res = await postJson("/api/slots/project_context", "null", "PUT");
	expect(res.status).toBe(200);
});

// ── #1783: GET /api/proposals limit range ───────────────────────────────────
//
// `limit` was coerced and floored with no range check, so 0 or 1001 reached the
// service; the shared `proposalsLimitSchema` (1–1000) now rejects them.

test("GET /api/proposals with limit 0 yields 400 (was passed through)", async () => {
	const res = await request("/api/proposals?limit=0");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toBeString();
});

test("GET /api/proposals with limit above 1000 yields 400 (was passed through)", async () => {
	const res = await request("/api/proposals?limit=1001");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toBeString();
});

test("GET /api/proposals with a non-numeric limit yields 400 (was ignored)", async () => {
	const res = await request("/api/proposals?limit=abc");
	expect(res.status).toBe(400);
	expect(await errorOf(res)).toBeString();
});

test("GET /api/proposals with a valid limit still succeeds", async () => {
	const res = await request("/api/proposals?limit=50");
	expect(res.status).toBe(200);
});

test("GET /api/proposals without a limit still succeeds (default 100)", async () => {
	const res = await request("/api/proposals");
	expect(res.status).toBe(200);
});
