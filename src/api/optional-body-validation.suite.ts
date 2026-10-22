import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { closeDb } from "../db/init";
import { createTestDb } from "../test/helpers";
import { createApp } from "./router";

const enqueueThoughtProposalsMock = mock(async () => []);
const rollbackServiceMock = mock(() => ({}));
const applyProposalServiceMock = mock(() => ({}));

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	isEmbedderReady: () => true,
}));

mock.module("../services/placement-proposals.service", () => ({
	enqueueThoughtProposals: enqueueThoughtProposalsMock,
	listPlacementProposalsService: () => [],
	rejectPlacementProposalService: () => ({}),
}));
mock.module("../services/placement-rollback.service", () => ({ rollbackService: rollbackServiceMock }));
mock.module("../services/placement-apply.service", () => ({ applyProposalService: applyProposalServiceMock }));

process.env.SYNAPTOMIND_SECRET = "test-token";
const app = createApp();

async function postJson(path: string, body: string): Promise<Response> {
	return await app.request(path, {
		method: "POST",
		body,
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
	});
}

async function postWithoutBody(path: string): Promise<Response> {
	return await app.request(path, { method: "POST", headers: { Authorization: "Bearer test-token" } });
}

beforeEach(createTestDb);
afterEach(closeDb);

test("optional-body endpoints reject invalid payload types", async () => {
	const cases = [
		["/api/thoughts/propose", { content: false }],
		["/api/proposals", { thought_id: 42 }],
		["/api/proposals/rollback", { run_id: "run-1", confirm: "yes" }],
		["/api/proposals/test-id/apply", { confirm: 1 }],
	] as const;
	for (const [path, payload] of cases) {
		expect((await postJson(path, JSON.stringify(payload))).status).toBe(400);
	}
});

test("optional-body endpoints accept valid payloads", async () => {
	const valid = [
		["/api/thoughts/propose", { content: "draft text" }],
		["/api/proposals/rollback", { run_id: "run-1", confirm: false }],
		["/api/proposals/test-id/apply", { confirm: false }],
	] as const;
	for (const [path, payload] of valid) {
		expect((await postJson(path, JSON.stringify(payload))).status).not.toBe(400);
	}
});

test("the removed auto-link and edge-detect routes are no longer mounted (404)", async () => {
	for (const path of ["/api/thoughts/auto-link", "/api/thoughts/edge-detect"]) {
		expect((await postWithoutBody(path)).status).toBe(404);
		expect((await postJson(path, JSON.stringify({ dry_run: true }))).status).toBe(404);
	}
});

test("invalid write bodies do not invoke their mutation services", async () => {
	const cases = [
		["/api/proposals", { thought_id: 42 }, enqueueThoughtProposalsMock],
		["/api/proposals/rollback", { run_id: "run-1", confirm: "yes" }, rollbackServiceMock],
		["/api/proposals/test-id/apply", { confirm: 1 }, applyProposalServiceMock],
	] as const;
	for (const [path, payload, service] of cases) {
		service.mockClear();
		expect((await postJson(path, JSON.stringify(payload))).status).toBe(400);
		expect(service).not.toHaveBeenCalled();
	}
});
