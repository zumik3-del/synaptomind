import { expect, test } from 'bun:test'

// The batch-loop suite drives the REAL embedder worker (`embedder-process.ts`),
// which is a side-effect module — importing it runs `initDb()`, validates the
// model and starts a poll worker. Driving it needs `mock.module` for four
// modules (../db/init, ./model, ./model-validator, ./queue), and bun's
// `mock.module` leaks through `export *`, so the suite runs in a child bun
// process with a clean module registry (same pattern as batch-chunking.test.ts).
test(
  'embedder batch loop suite (isolated process)',
  async () => {
    const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-batch-loop.suite.ts'], {
      cwd: `${import.meta.dir}/../..`,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    // The worker runs on timers; a wedged child must fail this test, not hang the run.
    const deadline = setTimeout(() => proc.kill(), 60_000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    clearTimeout(deadline)

    if (exitCode !== 0) {
      console.error('[embedder-batch-loop.test] isolated suite failed:\n' + stdout + '\n' + stderr)
    }
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toContain('0 fail')
  },
  // A failing child can spend its own per-test timeouts before it exits, so this
  // test's ceiling is the child's kill deadline, not bun's 5 s default.
  60_000
)
