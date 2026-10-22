import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDb, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import v019 from "./migrations/v019-thought-verify";
import v025 from "./migrations/v025-timestamp-normalize";

beforeEach(createTestDb);
afterEach(closeDb);

test("retired verifier migration remains replayable and retains existing rows", () => {
	const db = getDb();
	const id = seedThought({ content: "legacy verified thought" });
	const legacy = "2024-01-01 12:00:00";
	// v043 dropped the table from the live schema; replaying the historical
	// migration on a legacy DB must still recreate it and keep its rows.
	v019.apply(db);
	db.prepare(`INSERT INTO thought_verify (id, thought_id, flagged, created_at, last_checked)
		VALUES (?, ?, 1, ?, ?)`).run(Bun.randomUUIDv7(), id, legacy, legacy);

	v019.apply(db);
	const row = db.prepare(`SELECT flagged, created_at, last_checked FROM thought_verify WHERE thought_id = ?`)
		.get(id) as { flagged: number; created_at: string; last_checked: string };
	expect(row).toEqual({ flagged: 1, created_at: legacy, last_checked: legacy });
});

test("v025 normalizes retained verifier timestamps on the historical schema", () => {
	const db = new Database(":memory:");
	try {
		// v025 expects the v024 schema, including tables subsequently retired.
		for (const [table, columns] of Object.entries({
			thoughts: ["created_at", "updated_at"], edges: ["created_at", "source_id", "type"],
			projects: ["created_at"], tags: ["created_at"], pending_embeddings: ["created_at"],
			pending_git_embeddings: ["created_at"], thought_importance: ["last_decay", "created_at"],
			primers: ["promoted_at", "created_at"], smart_notes: ["surface_checked_at", "created_at"],
			slots: ["updated_at"], git_commits: ["created_at"],
		})) db.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, ${columns.map(c => `${c} TEXT`).join(", ")})`);
		v019.apply(db);
		db.prepare(`INSERT INTO thought_verify (id, thought_id, created_at, last_checked) VALUES (?, ?, ?, ?)`)
			.run("old", "thought", "2024-01-01 12:00:00", "2024-01-01 12:00:00");
		v025.apply(db);
		const row = db.prepare(`SELECT created_at, last_checked FROM thought_verify WHERE id = 'old'`)
			.get() as { created_at: string; last_checked: string };
		expect(row).toEqual({ created_at: "2024-01-01T12:00:00.000Z", last_checked: "2024-01-01T12:00:00.000Z" });
	} finally {
		db.close();
	}
});
