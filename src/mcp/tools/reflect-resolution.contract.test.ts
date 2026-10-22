import { expect, test } from 'bun:test'

// The reflect-resolution suite (reflect-resolution.suite.ts) mocks.module()
// '../../services/projects.service' globally — the singleton the MCP tools
// resolve projects through. bun cannot unmock modules, so a leaked partial mock
// silently breaks later files (memory_manage list/create, project-scoped
// recall) depending on file order. Run it in a child bun process with a clean
// module registry (AGENTS.md §8, task #1932).
test('reflect-resolution suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/tools/reflect-resolution.suite.ts'], {
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
    console.error('[reflect-resolution.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})
