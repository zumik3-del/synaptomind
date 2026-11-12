import { expect, test } from 'bun:test'

// The auto_cluster option pass-through suite (action-tool.auto-cluster.suite.ts)
// stub-mocks ../../services/auto-cluster.service globally. bun cannot unmock
// modules, and under the serial oracle that stub leaked into every later file —
// the auto-cluster fingerprint matrix then measured a frozen plan and accepted
// every drifted confirm (task #2496). The suite must therefore run in a child
// bun process with a clean module registry (AGENTS.md §8).
test('action-tool auto_cluster suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/tools/action-tool.auto-cluster.suite.ts'], {
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
    console.error(
      '[action-tool.auto-cluster.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr
    )
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)
