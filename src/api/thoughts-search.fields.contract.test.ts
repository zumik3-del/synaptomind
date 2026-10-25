import { expect, test } from 'bun:test'

/**
 * Task #2178 — HTTP regression guard for `GET /api/thoughts/search`.
 *
 * Runs `thoughts-search.fields.suite.ts` in its own process. Isolation is
 * required for two reasons:
 *
 * 1. The suite mocks `../embedder/client` (the `mock.module` leakage gotcha,
 *    AGENTS.md §8) — a fresh process confines the mock to this contract.
 * 2. The API rate limiter is a process-wide instance with a 200-requests/60 s
 *    budget shared by every in-process `app.request` call, and the rest of the
 *    API suite already sits at that boundary: an extra HTTP file in the main
 *    process flips `retention-review.test.ts` to HTTP 429. A child process gets
 *    its own store.
 *
 * The suite's vector cases are `test.skipIf` on vec0 availability, so the exit
 * code (not a "no skip" text match) is the gate here.
 */
test('thoughts-search.fields suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/api/thoughts-search.fields.suite.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])

  if (exitCode !== 0) {
    console.error('[thoughts-search.fields.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})
