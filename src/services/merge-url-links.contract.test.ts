import { expect, test } from 'bun:test'

// The merge url-link suite (merge-url-links.suite.ts) mock.modules
// '../logging/log' so the collision warning can be read from the sink the merge
// writes to — bun cannot unmock a module, so that suite runs in a child process
// with a clean module registry (AGENTS.md §8; same recipe as
// retention-review.audit / placement-apply-runid-logging).
test('merge url-links suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/services/merge-url-links.suite.ts'], {
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
    console.error(
      '[merge-url-links.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr
    )
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)
