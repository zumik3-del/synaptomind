#!/usr/bin/env bun
/**
 * Parallel test runner: shards `src/**\/*.test.ts` across several `bun test`
 * processes.
 *
 * Why: Bun runs test files sequentially in one process, so the suite's wall time
 * is the sum of its files (one core busy, the rest idle). Splitting the files
 * into N shards is the only lever that uses more cores — measured ~2.5x on this
 * suite with 4 shards.
 *
 * The file list, the lanes and the shard weights live in `src/test/lanes.ts`.
 * Every shard runs the same `bun test <files…>`, so the union of the shards is
 * exactly the set `bun test src` would run.
 *
 * Usage:
 *   bun run scripts/test-parallel.ts                 # all src tests
 *   bun run scripts/test-parallel.ts --lane unit     # the fast lane
 *   bun run scripts/test-parallel.ts --lane integration
 *   bun run scripts/test-parallel.ts --shards 8
 *   bun run scripts/test-parallel.ts -- --bail       # args after `--` go to bun test
 *
 * Passing shards print one summary line each; failing shards print their whole
 * output before the aggregate summary. Exit code is non-zero if any shard failed.
 */
import { availableParallelism } from "node:os";
import { type Lane, REPO_ROOT, splitIntoShards, testFiles } from "../src/test/lanes";

interface Options {
	lane?: Lane;
	/** `undefined` = derive from the file count (see `defaultShards`). */
	shards: number | undefined;
	passThrough: string[];
	verbose: boolean;
}

/** Upper bound on shards: more processes than this only add start-up cost. */
const MAX_SHARDS = Math.min(6, Math.max(1, availableParallelism()));

/**
 * Shards for a file count when `--shards` is not given: at most `MAX_SHARDS`,
 * and never fewer than ~2.5 files per shard. Each shard pays its own process
 * start-up (module graph, preload), so the 10-file integration lane is FASTER
 * with 4 shards (8.6 s) than with 6 (13.0 s), while the 148-file unit lane
 * wants all 6.
 */
function defaultShards(fileCount: number): number {
	return Math.min(MAX_SHARDS, Math.max(1, Math.ceil(fileCount / 2.5)));
}

function usage(): string {
	return `usage: bun run scripts/test-parallel.ts [--lane unit|integration] [--shards N] [--verbose] [-- <bun test args>]`;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { shards: undefined, passThrough: [], verbose: false };
	let index = 0;
	for (; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--") {
			index += 1;
			break;
		}
		if (arg === "--lane") {
			const lane = argv[index + 1];
			if (lane !== "unit" && lane !== "integration") {
				throw new Error(`--lane expects "unit" or "integration", got ${lane ?? "nothing"}`);
			}
			options.lane = lane;
			index += 1;
		} else if (arg === "--shards") {
			const raw = argv[index + 1];
			const shards = Number(raw);
			if (!Number.isInteger(shards) || shards < 1) {
				throw new Error(`--shards expects a positive integer, got ${raw ?? "nothing"}`);
			}
			options.shards = shards;
			index += 1;
		} else if (arg === "--verbose") {
			options.verbose = true;
		} else if (arg === "-h" || arg === "--help") {
			console.log(usage());
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}\n${usage()}`);
		}
	}
	options.passThrough = argv.slice(index);
	return options;
}

interface ShardResult {
	index: number;
	files: string[];
	code: number;
	output: string;
	ms: number;
	pass: number;
	fail: number;
	skip: number;
}

function count(output: string, word: string): number {
	const match = output.match(new RegExp(`(\\d+) ${word}\\b`));
	return match ? Number(match[1]) : 0;
}

async function runShard(
	index: number,
	files: string[],
	options: Options,
	running: Set<ReturnType<typeof Bun.spawn>>,
): Promise<ShardResult> {
	const started = performance.now();
	const proc = Bun.spawn([process.execPath, "test", ...files, ...options.passThrough], {
		cwd: REPO_ROOT,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	running.add(proc);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	running.delete(proc);
	const output = stdout + stderr;
	const ms = performance.now() - started;
	return { index, files, code, output, ms, pass: count(output, "pass"), fail: count(output, "fail"), skip: count(output, "skip") };
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const files = testFiles(options.lane);
	if (files.length === 0) {
		console.error(`no test files found for lane ${options.lane ?? "(all)"}`);
		process.exit(1);
	}

	const shards = splitIntoShards(files, options.shards ?? defaultShards(files.length));
	const lane = options.lane ?? "all";
	const started = performance.now();
	console.log(
		`[tests] ${files.length} files · lane ${lane} · ${shards.length} shard${shards.length === 1 ? "" : "s"}` +
			(options.passThrough.length > 0 ? ` · passing through: ${options.passThrough.join(" ")}` : ""),
	);
	if (options.verbose) {
		for (const [position, shard] of shards.entries()) {
			console.log(`[tests] shard ${position + 1}: ${shard.join(" ")}`);
		}
	}

	// Keep children reachable so Ctrl-C does not orphan a shard.
	const running = new Set<ReturnType<typeof Bun.spawn>>();
	const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
		for (const child of running) child.kill();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.on("SIGINT", () => onSignal("SIGINT"));
	process.on("SIGTERM", () => onSignal("SIGTERM"));

	const results = await Promise.all(
		shards.map(async (shard, position) => {
			const result = await runShard(position, shard, options, running);
			const mark = result.code === 0 ? "✓" : "✗";
			console.log(
				`[tests] ${mark} shard ${position + 1}/${shards.length} · ${shard.length} files · ${seconds(result.ms)}` +
					`${result.code === 0 ? "" : ` · exit ${result.code}`}`,
			);
			return result;
		}),
	);

	const failed = results.filter((result) => result.code !== 0);
	for (const result of failed) {
		console.error(`\n[tests] ── shard ${result.index + 1} output (exit ${result.code}) ──`);
		console.error(result.output.trimEnd());
	}

	const total = results.reduce(
		(sum, result) => ({
			pass: sum.pass + result.pass,
			fail: sum.fail + result.fail,
			skip: sum.skip + result.skip,
		}),
		{ pass: 0, fail: 0, skip: 0 },
	);
	const wall = seconds(performance.now() - started);
	const slowest = Math.max(...results.map((result) => result.ms));
	const summary =
		`[tests] ${failed.length === 0 ? "PASS" : "FAIL"} · ${total.pass} pass` +
		`${total.skip > 0 ? ` · ${total.skip} skip` : ""} · ${total.fail} fail · ${files.length} files · ${wall}` +
		` (slowest shard ${seconds(slowest)})`;
	if (failed.length === 0) console.log(summary);
	else console.error(summary);
	process.exit(failed.length === 0 ? 0 : 1);
}

await main();
