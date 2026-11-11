import { expect, test } from 'bun:test'

// The modern-leg limits suite overrides the mcp.maxSubscriptions/maxSessions
// config values via env and replaces ./server with a counting wrapper, so it
// runs in its own bun process (see http-transport.limits.test.ts).
test('MCP modern limits suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/http-transport.modern-limits.suite.ts'], {
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
      '[http-transport.modern-limits.test] isolated suite failed:\n' + stdout + '\n' + stderr
    )
  }
  expect(exitCode).toBe(0)
  expect(Number((stdout + stderr).match(/(\d+)\s+pass/)?.[1] ?? 0)).toBeGreaterThan(0)
  expect(stdout + stderr).toContain('0 fail')
}, 60_000)
