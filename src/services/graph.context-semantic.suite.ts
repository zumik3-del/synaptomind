import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
	drainPendingEmbeddings,
	isVecExtensionAvailable,
	seedThought,
	withVecDb,
} from "../test/helpers";
import { getContextService } from "./graph.service";

const VECTOR = new Float32Array(384);
for (let i = 0; i < VECTOR.length; i++) VECTOR[i] = 0.25;

mock.module("../embedder/client", () => ({
	generateEmbedding: async () => VECTOR,
	generateEmbeddings: async () => [VECTOR],
	isEmbedderReady: () => true,
}));

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
	test.skipIf(!isVecExtensionAvailable())(name, () => withVecDb(fn));
}

describe("getContextService uses real embeddings", () => {
	itVec("returns a semantically matched thought even when BM25 does not match", async (db) => {
		const id = seedThought({ content: "semantic context target thought" });
		drainPendingEmbeddings([id]);
		const buf = Buffer.from(VECTOR.buffer, VECTOR.byteOffset, VECTOR.byteLength);
		db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(id, buf);

		const ctx = await getContextService("zzzznomatchtoken", 3, undefined, db);

		expect(ctx).not.toBeNull();
		expect(ctx!.best_match!.id).toBe(id);
		expect(ctx!.degraded).toBe(false);
	});
});