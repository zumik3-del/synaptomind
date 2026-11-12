import { expect, test } from 'bun:test'

// The sweep suite drives the REAL embedder worker (`embedder-process.ts`), a
// side-effect module whose `mock.module` calls leak through `export *`, so it
// runs in a child bun process with a clean registry (same pattern as
// embedder-batch-loop.test.ts). Both handlers it needs are captured from the
// timer seam, so the child never waits on the hourly interval.
test('embedder orphan sweep suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-sweep.suite.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const deadline = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  clearTimeout(deadline)

  const output = stdout + stderr
  if (exitCode !== 0) console.error('[embedder-sweep.test] isolated suite failed:\n' + output)
  expect(exitCode).toBe(0)
  // A fully skipped suite also ends in "0 fail"; require real assertions to run.
  expect(Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0)).toBeGreaterThan(0)
  expect(output).toContain('0 fail')
}, 30_000)
