import { expect, test } from 'bun:test'

test('retention review audit isolated suite', async () => {
 const proc = Bun.spawn(['bun', 'test', './src/services/retention-review.audit.suite.ts'], { stdout: 'pipe', stderr: 'pipe' })
 const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
 expect(code, `${stdout}\n${stderr}`).toBe(0)
}, 30_000)
