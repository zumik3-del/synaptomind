import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { allTestFiles, INTEGRATION_TESTS, laneOf, REPO_ROOT, splitIntoShards, testFiles, weightOf } from "./lanes";

/**
 * Guard for the parallel runner's manifest (`src/test/lanes.ts`).
 *
 * The manifest decides which files run in the fast lane and how the shards are
 * balanced. Nothing else checks it, so a renamed file or a new entrypoint test
 * could quietly weaken the split: a stale entry makes `--lane integration` run
 * fewer files than intended, and an unlisted entrypoint test drags a 1.4 s boot
 * into the edit/run loop.
 */

/** A test file that spawns the app entry point or binds a real listener. */
const SPAWNS_PROCESS = /Bun\.spawn\(|spawnSync\(|spawn\(|execFileSync\(/;
const ENTRYPOINT = /index\.ts/;
const BINDS_LISTENER = /Bun\.serve\(|createServer\(|\.listen\(/;

describe("test lanes", () => {
	test("every listed integration file still exists", () => {
		const known = new Set(allTestFiles());
		const missing = INTEGRATION_TESTS.filter(file => !known.has(file));

		expect(missing).toEqual([]);
	});

	test("the list has no duplicates", () => {
		expect(new Set(INTEGRATION_TESTS).size).toBe(INTEGRATION_TESTS.length);
	});

	test("a test file that boots the entry point or binds a listener is in the slow lane", async () => {
		// One-directional on purpose: the manifest may also hold files that are
		// merely expensive (the embedder lifecycle suite, the source-tree guard).
		// Files already in the slow lane need no reading, and the rest are read
		// concurrently — a serial pass costs ~1 s on a slow mount.
		const candidates = allTestFiles().filter(file => laneOf(file) !== "integration");
		const sources = await Promise.all(
			candidates.map(async file => ({ file, source: await Bun.file(join(REPO_ROOT, file)).text() })),
		);
		const offenders = sources
			.filter(({ source }) => (SPAWNS_PROCESS.test(source) && ENTRYPOINT.test(source)) || BINDS_LISTENER.test(source))
			.map(({ file }) => file);

		expect(offenders).toEqual([]);
	});

	test("the lanes partition the suite: every file is in exactly one of them", () => {
		const all = allTestFiles();
		const unit = testFiles("unit");
		const integration = testFiles("integration");

		expect(unit.filter(file => integration.includes(file))).toEqual([]);
		expect(unit.length + integration.length).toBe(all.length);
		expect([...unit, ...integration].sort()).toEqual(all);
		expect(laneOf("src/db/thoughts.test.ts")).toBe("unit");
	});

	test("shard splitting covers every file exactly once and respects the shard count", () => {
		const files = allTestFiles();
		for (const shards of [1, 2, 3, 4, 8]) {
			const split = splitIntoShards(files, shards);
			const covered = split.flat().sort();

			expect(split.length).toBeLessThanOrEqual(shards);
			expect(covered).toEqual([...files].sort());
		}
	});

	test("the heaviest files land in different shards", () => {
		const files = allTestFiles();
		const heaviest = files.filter(file => weightOf(file) > 1).sort((a, b) => weightOf(b) - weightOf(a));
		const shards = splitIntoShards(files, 4);
		const placement = heaviest.map(file => shards.findIndex(shard => shard.includes(file)));

		expect(placement.every(index => index >= 0)).toBe(true);
		// The two most expensive files must not share a shard.
		expect(placement[0]).not.toBe(placement[1]);
	});
});
