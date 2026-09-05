import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";

const pkg = JSON.parse(
	readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"),
) as { version: string };

const CLI = resolve(import.meta.dir, "index.ts");
const BUN = process.execPath;

test("--version prints version and exits 0", () => {
	const result = execFileSync(BUN, ["run", CLI, "--version"], {
		encoding: "utf-8",
		timeout: 5000,
	});
	expect(result.trim()).toBe(`synaptomind v${pkg.version}`);
});

test("-v prints version and exits 0", () => {
	const result = execFileSync(BUN, ["run", CLI, "-v"], {
		encoding: "utf-8",
		timeout: 5000,
	});
	expect(result.trim()).toBe(`synaptomind v${pkg.version}`);
});
