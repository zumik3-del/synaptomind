import { expect, test } from 'bun:test'

test('recall-context-semantic suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/mcp/tools/recall-context-semantic.suite.ts'], {
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
    console.error('[recall-context-semantic.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})