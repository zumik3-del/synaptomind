import { expect, test } from 'bun:test'

test('multi-user embedder scheduler (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-multi-scheduler.suite.ts'], {
    cwd: `${import.meta.dir}/../..`, env: process.env, stdout: 'pipe', stderr: 'pipe'
  })
  const deadline = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
  ])
  clearTimeout(deadline)
  if (code !== 0) console.error(stdout + stderr)
  expect(code).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)
