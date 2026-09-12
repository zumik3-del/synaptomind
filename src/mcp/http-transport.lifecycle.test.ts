import { expect, test } from 'bun:test'

// The MCP HTTP lifecycle suite (http-transport.lifecycle.suite.ts) lowers the
// transport timings via env and mocks ./server, so it runs in a child bun
// process with a clean module registry. bun cannot unmock modules, and the
// config singleton is built at first import — an in-process suite would be
// order-dependent.
test('MCP HTTP lifecycle suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/http-transport.lifecycle.suite.ts'], {
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
    console.error('[http-transport.lifecycle.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})
