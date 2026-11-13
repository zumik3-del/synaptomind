import { expect, test } from 'bun:test'

// The project-deletion logging suite (projects-deletion-logging.suite.ts) mock.modules
// ../logging/log so `insertLog` can be spied — insertLog routes to stdout/stderr sinks in
// tests. bun cannot unmock modules, so the suite must run in a child bun process with a
// clean module registry (AGENTS.md §8; same recipe as placement-apply-runid-logging).
test('project deletion logging suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/db/projects-deletion-logging.suite.ts'], {
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
      '[projects-deletion-logging.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr
    )
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)
