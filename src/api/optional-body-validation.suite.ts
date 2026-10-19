import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { closeDb } from "../db/init";
import { createTestDb } from "../test/helpers";
import { createApp } from "./router";

const restartEmbedderMock = mock(() => {});
const runAutoClusterJobMock = mock(async () => ({}));
const runAutoLinkJobMock = mock(async () => ({ linked: 0 }));
const runSelfImproveJobMock = mock(async () => ({}));
const enqueueThoughtProposalsMock = mock(async () => []);
const rollbackServiceMock = mock(() => ({}));
const applyProposalServiceMock = mock(() => ({}));

mock.module("../embedder/client", () => ({
	generateEmbedding: () => new Float32Array(384),
	generateEmbeddings: () => [new Float32Array(384)],
	restartEmbedder: restartEmbedderMock,
	isEmbedderReady: () => true,
}));

mock.module("../services/auto-link.service", () => ({ runAutoLinkJob: runAutoLinkJobMock }));
mock.module("../services/auto-cluster.service", () => ({
	getLastAutoClusterStatus: () => null,
	runAutoClusterJob: runAutoClusterJobMock,
}));
mock.module("../services/self-improve.service", () => ({
	getLastSelfImproveStatus: () => null,
	runSelfImproveJob: runSelfImproveJobMock,
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
		["/api/auto-cluster/trigger", { dry_run: "yes" }],
		["/api/thoughts/auto-link", { dry_run: 1, max_edges: "many" }],
		["/api/thoughts/edge-detect", { project_id: 7 }],
		["/api/thoughts/propose", { content: false }],
		["/api/thoughts/self-improve/run", { dry_run: "true" }],
		["/api/proposals", { thought_id: 42 }],
		["/api/proposals/rollback", { run_id: "run-1", confirm: "yes" }],
		["/api/proposals/test-id/apply", { confirm: 1 }],
	] as const;
	for (const [path, payload] of cases) {
		expect((await postJson(path, JSON.stringify(payload))).status).toBe(400);
	}
});

test("optional-body endpoints retain absent and null defaults and accept valid payloads", async () => {
	const paths = ["/api/auto-cluster/trigger", "/api/thoughts/auto-link", "/api/thoughts/edge-detect", "/api/thoughts/self-improve/run"];
	for (const path of paths) {
		expect((await postWithoutBody(path)).status).not.toBe(400);
		expect((await postJson(path, "null")).status).not.toBe(400);
	}
	const valid = [
		["/api/thoughts/auto-link", { dry_run: true, max_edges: 5 }],
		["/api/thoughts/edge-detect", { project_id: "test-project", min_similarity: 0.8, max_proposals: 5 }],
		["/api/thoughts/propose", { content: "draft text" }],
		["/api/thoughts/self-improve/run", { dry_run: true }],
		["/api/proposals/rollback", { run_id: "run-1", confirm: false }],
		["/api/proposals/test-id/apply", { confirm: false }],
	] as const;
	for (const [path, payload] of valid) {
		expect((await postJson(path, JSON.stringify(payload))).status).not.toBe(400);
	}
});

test("invalid auto-link options are rejected before the job starts", async () => {
	runAutoLinkJobMock.mockClear();
	expect((await postJson("/api/thoughts/auto-link", JSON.stringify({ max_edges: "many" }))).status).toBe(400);
	expect(runAutoLinkJobMock).not.toHaveBeenCalled();
});

test("invalid optional write bodies do not invoke their mutation services", async () => {
	const cases = [
		["/api/auto-cluster/trigger", { dry_run: "yes" }, runAutoClusterJobMock],
		["/api/thoughts/auto-link", { dry_run: 1 }, runAutoLinkJobMock],
		["/api/thoughts/self-improve/run", { dry_run: "true" }, runSelfImproveJobMock],
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

test("auto-cluster min_age_days is bounded to 0 through 3650", async () => {
	for (const min_age_days of [-1, 3651]) {
		expect((await postJson("/api/auto-cluster/trigger", JSON.stringify({ min_age_days }))).status).toBe(400);
	}
	for (const min_age_days of [0, 3650]) {
		expect((await postJson("/api/auto-cluster/trigger", JSON.stringify({ min_age_days, dry_run: true }))).status).not.toBe(400);
	}
});

test("auto-cluster min_members is bounded to 1 through 1000", async () => {
	for (const min_members of [0, 1001]) {
		expect((await postJson("/api/auto-cluster/trigger", JSON.stringify({ min_members }))).status).toBe(400);
	}
	for (const min_members of [1, 1000]) {
		expect((await postJson("/api/auto-cluster/trigger", JSON.stringify({ min_members, dry_run: true }))).status).not.toBe(400);
	}
});
