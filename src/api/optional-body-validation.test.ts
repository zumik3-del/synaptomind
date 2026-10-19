import { expect, test } from "bun:test";

test("optional-body-validation suite (isolated process)", async () => {
	const proc = Bun.spawn(["bun", "test", "./src/api/optional-body-validation.suite.ts"], {
		cwd: `${import.meta.dir}/../..`,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		console.error("[optional-body-validation.test] isolated suite failed:\n" + stdout + "\n" + stderr);
	}
	expect(exitCode).toBe(0);
	expect(stdout + stderr).toContain("0 fail");
});
