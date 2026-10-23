import { expect, test } from 'bun:test'

test('retention-review config integration runs in an isolated process', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/config.retention-review.integration.suite.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
})
