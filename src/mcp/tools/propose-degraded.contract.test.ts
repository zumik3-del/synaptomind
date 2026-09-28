import { expect, test } from 'bun:test'

// The propose-degraded suite (propose-degraded.suite.ts) mocks.module('../../embedder/client')
// globally. bun cannot unmock modules, so this suite must run in a child bun
// process with a clean module registry (PR #114, b2e5cd5; AGENTS.md §8).
test('propose-degraded suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/tools/propose-degraded.suite.ts'], {
    cwd: `${import.meta.dir}/../../..`,
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
    console.error('[propose-degraded.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})
