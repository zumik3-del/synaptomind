import { expect, test } from 'bun:test'

// The placement-rollback logging suite (placement-rollback-logging.suite.ts)
// mock.module('../logging/log') globally so `insertLog` can be spied —
// config.logDbPath is '' in tests, so the writer is a silent no-op. bun cannot
// unmock modules, so this suite must run in a child bun process with a clean
// module registry (AGENTS.md §8; same recipe as client.suite.ts /
// propose-degraded.suite.ts, PR #114 b2e5cd5).
test('placement-rollback logging suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/services/placement-rollback-logging.suite.ts'], {
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
    console.error('[placement-rollback-logging.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})
