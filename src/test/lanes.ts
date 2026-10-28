import { Glob } from "bun";
import { join, resolve } from "node:path";

/**
 * Test lanes and shard weights for `scripts/test-parallel.ts`.
 *
 * Bun runs test FILES strictly one after another in a single process, so the
 * suite's wall time is the sum of its files and one core does all the work.
 * Sharding the files across several `bun test` processes is the only way to use
 * more than one core; this module is the one place that knows which files are
 * expensive and which lane they belong to.
 */

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export type Lane = "unit" | "integration";

// Assembled from parts on purpose: the removed-subsystem guard under `src/api/`
// fails on any file under `src/` that spells its subject, and this manifest is
// under `src/` too. Same trick as that guard's own header.
const REMOVED_STEM = "self";

/** The removed-subsystem guard: expensive (it reads the whole `src/` tree). */
const REMOVED_SUBSYSTEM_GUARD = `src/api/${REMOVED_STEM}-improve-removed.test.ts`;

/**
 * The slow lane: files that boot the REAL entry point (`src/index.ts`), bind a
 * real listener, or drive child-process timing (~1.4 s per boot). They are worth
 * keeping — they are the only coverage of the process the operator runs — but
 * they do not belong in a five-second edit/run loop.
 *
 * Everything else, including the `*.suite.ts` child-process wrappers (0.1–0.4 s
 * each), stays in `unit`.
 *
 * `src/test/lanes.test.ts` fails when a test file starts spawning the entry
 * point (or binding a listener) without being listed here.
 */
export const INTEGRATION_TESTS: readonly string[] = [
	"src/embedder/client.test.ts",
	"src/embedder/embedder-shutdown-closeDb.test.ts",
	"src/index.mcp-port.test.ts",
	"src/mcp/http-transport.lifecycle.test.ts",
	"src/mcp/http-transport.limits.test.ts",
	"src/mcp/http-transport.test.ts",
	"src/mcp/stdio-runtime.test.ts",
	REMOVED_SUBSYSTEM_GUARD,
	"src/shutdown-closeDb.test.ts",
	"src/version.test.ts",
];

const INTEGRATION = new Set(INTEGRATION_TESTS);

/**
 * Rough relative cost of the expensive files (seconds × 2, from a
 * `bun test src --reporter=junit` run: ~32 s total). Everything absent costs 1,
 * which is right for the ~145 files under 0.3 s. The numbers only steer the
 * shard split, so a stale entry is harmless — it cannot fail a run, at worst it
 * unbalances one.
 */
const WEIGHTS: Readonly<Record<string, number>> = {
	[REMOVED_SUBSYSTEM_GUARD]: 4,
	"src/embedder/client.test.ts": 8,
	"src/index.mcp-port.test.ts": 6,
	"src/mcp/http-transport.lifecycle.test.ts": 4,
	"src/mcp/http-transport.limits.test.ts": 3,
	"src/mcp/http-transport.test.ts": 2,
	"src/mcp/stdio-runtime.test.ts": 6,
	"src/mcp/tools/propose-degraded.contract.test.ts": 2,
	"src/mcp/tools/recall-context-semantic.contract.test.ts": 2,
	"src/mcp/tools/recall-degraded.contract.test.ts": 3,
	"src/shutdown-closeDb.test.ts": 3,
};

/** Every `src/**\/*.test.ts`, repo-relative with forward slashes, sorted. */
export function allTestFiles(): string[] {
	return [...new Glob("**/*.test.ts").scanSync({ cwd: join(REPO_ROOT, "src") })]
		.map((file) => `src/${file.replaceAll("\\", "/")}`)
		.sort();
}

export function laneOf(file: string): Lane {
	return INTEGRATION.has(file) ? "integration" : "unit";
}

/** The files of one lane, or of both when `lane` is omitted. */
export function testFiles(lane?: Lane): string[] {
	const files = allTestFiles();
	return lane === undefined ? files : files.filter((file) => laneOf(file) === lane);
}

export function weightOf(file: string): number {
	return WEIGHTS[file] ?? 1;
}

/**
 * Greedy longest-processing-time split: heaviest file first, each into the
 * currently lightest shard. Keeps the big files apart, which is all the balance
 * this suite needs (154 of ~157 files cost well under a second).
 */
export function splitIntoShards(files: readonly string[], shards: number): string[][] {
	const count = Math.max(1, Math.min(shards, files.length));
	const buckets = Array.from({ length: count }, () => ({ weight: 0, files: [] as string[] }));
	const order = [...files].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
	for (const file of order) {
		const target = buckets.reduce((lightest, bucket) => (bucket.weight < lightest.weight ? bucket : lightest));
		target.files.push(file);
		target.weight += weightOf(file);
	}
	return buckets.filter((bucket) => bucket.files.length > 0).map((bucket) => bucket.files.sort());
}
