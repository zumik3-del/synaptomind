import { describe, expect, test } from "bun:test";
import { config } from "../config";

function freshLog(): typeof import("./log") {
	config.logDbPath = ":memory:";
	delete require.cache[require.resolve("./log")];
	const log = require("./log");
	log.closeLogDb();
	return log;
}

describe("insertLog", () => {
	test("inserts a row", () => {
		const log = freshLog();
		log.insertLog("info", "test", "hello", { item: "value" });

		const db = log.getLogDb();
		expect(db).not.toBeNull();
		const rows = db?.query("SELECT * FROM logs").all() as Array<
			Record<string, unknown>
		>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const lastRow = rows[rows.length - 1];
		expect(lastRow.level).toBe("info");
		expect(lastRow.message).toBe("hello");
		expect(JSON.parse(lastRow.metadata as string)).toEqual({ item: "value" });
		log.closeLogDb();
	});

	test("skips debug when show_debug is false", () => {
		const log = freshLog();
		log.insertLog("info", "init", "create db first");
		log.insertLog("debug", "test", "should not appear");

		const db = log.getLogDb();
		const rows = db?.query("SELECT * FROM logs").all() as Array<
			Record<string, unknown>
		>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const lastRows = rows.slice(-2);
		const debugRows = lastRows.filter((r) => r.message === "should not appear");
		expect(debugRows.length).toBe(0);
		log.closeLogDb();
	});

	test("closes and reopens", () => {
		const log = freshLog();
		log.insertLog("info", "t", "first");
		log.closeLogDb();
		log.insertLog("info", "t", "second");

		const db = log.getLogDb();
		const rows = db?.query("SELECT * FROM logs").all() as Array<
			Record<string, unknown>
		>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const lastRow = rows[rows.length - 1];
		expect(lastRow.message).toBe("second");
		log.closeLogDb();
	});
});

describe("schema", () => {
	test("creates tables and indexes", () => {
		const log = freshLog();
		log.insertLog("info", "t", "schema test");
		const db = log.getLogDb();
		const tables = db
			?.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all() as Array<{ name: string }>;
		const names = tables.map((t) => t.name);
		expect(names).toContain("logs");
		log.closeLogDb();
	});
});

describe("metadata", () => {
	test("stores JSON metadata", () => {
		const log = freshLog();
		log.insertLog("info", "test", "json", { nested: { value: 42 } });
		const db = log.getLogDb();
		const row = db?.query("SELECT metadata FROM logs").get() as {
			metadata: string;
		};
		expect(JSON.parse(row.metadata)).toEqual({ nested: { value: 42 } });
		log.closeLogDb();
	});

	test("stores null metadata", () => {
		const log = freshLog();
		log.insertLog("info", "test", "no meta");
		const db = log.getLogDb();
		const row = db?.query("SELECT metadata FROM logs").get() as {
			metadata: string | null;
		};
		expect(row.metadata).toBeNull();
		log.closeLogDb();
	});
});
