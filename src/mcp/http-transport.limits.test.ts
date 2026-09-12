import { expect, test } from 'bun:test'

// The MCP HTTP limits suite (http-transport.limits.suite.ts) overrides the
// mcp.maxSessions/sessionTtlMs/keepAliveMs/maxEventsPerSession config values
// via env, which only takes effect in a child process with a clean module
// registry (the config singleton is built at first import).
test('MCP HTTP limits suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/http-transport.limits.suite.ts'], {
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
    console.error('[http-transport.limits.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})
