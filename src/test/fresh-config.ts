import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Load `src/config.ts` as a FRESH module instance, in this process.
 *
 * Why not a child process: `config.ts` is a side-effect module (`export const
 * config = applyEnvOverrides(loadFileConfig())`), and the load-time guards used
 * to spawn `bun -e` per case — ~60 ms of runtime start-up each, which added up
 * to ~2.5 s of the suite for a handful of assertions. A cache-busted dynamic
 * import re-evaluates the module with the environment that is installed right
 * before the call, so the same assertions run in microseconds. The pattern
 * (`import('...config.ts?probe=N')`) is the cache-busting trick the removed-
 * subsystem guard under `src/api/` already relies on.
 *
 * Isolation: the loaded module must not pick up the developer's own
 * `config.json`, so `SYNAPTOMIND_CONFIG` is pointed at a scratch path for the
 * duration of the load — at a real file when `configFile` is given, at a
 * non-existent path otherwise (the "no config.json" case, which logs and falls
 * back to the defaults exactly as production does).
 *
 * Both `process.env` and `console.error` are restored in `finally`.
 */

/** The absolute specifier, so the scratch `cwd` of the caller cannot change it. */
const CONFIG_TS = resolve(import.meta.dir, "..", "config.ts");

let probeCount = 0;

export interface FreshConfigLoad {
	/** The resolved runtime config, when the module loaded. */
	config?: Record<string, unknown>;
	/** The module's `DEFAULTS`, when it loaded. */
	defaults?: Record<string, unknown>;
	/** The thrown message, when the load aborted (e.g. an invalid dtype). */
	error?: string;
	/** Everything the config layer wrote to `console.error` while loading. */
	stderr: string;
}

export interface FreshConfigOptions {
	/** Environment to install for the load; `undefined` deletes the key. */
	env?: Record<string, string | undefined>;
	/** `config.json` payload to load, or `undefined` for "no file at all". */
	configFile?: unknown;
}

export async function loadFreshConfig(options: FreshConfigOptions = {}): Promise<FreshConfigLoad> {
	const scratch = mkdtempSync(join(tmpdir(), "synaptomind-config-probe-"));
	const configPath = join(scratch, "config.json");
	if (options.configFile !== undefined) {
		writeFileSync(configPath, JSON.stringify(options.configFile));
	}

	const saved = new Map<string, string | undefined>();
	const install = (key: string, value: string | undefined): void => {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};

	install("SYNAPTOMIND_CONFIG", configPath);
	for (const [key, value] of Object.entries(options.env ?? {})) install(key, value);

	const stderr: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		stderr.push(args.map(arg => String(arg)).join(" "));
	};
	try {
		probeCount += 1;
		const fresh = (await import(`${CONFIG_TS}?fresh=${probeCount}`)) as {
			config: Record<string, unknown>;
			DEFAULTS: Record<string, unknown>;
		};
		return { config: fresh.config, defaults: fresh.DEFAULTS, stderr: stderr.join("\n") };
	} catch (err: unknown) {
		return { error: err instanceof Error ? err.message : String(err), stderr: stderr.join("\n") };
	} finally {
		console.error = originalError;
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
	}
}
