import { expect, test } from 'bun:test'

const MODES = ['legacy-idle', 'legacy-shutdown', 'multi-idle']

test('embedder child cleanup order (isolated processes)', async () => {
  for (const mode of MODES) {
    const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-cleanup-order.suite.ts'], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, SYNAPTOMIND_CLEANUP_MODE: mode },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const deadline = setTimeout(() => proc.kill(), 30_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    clearTimeout(deadline)
    const output = stdout + stderr
    if (code !== 0) console.error(`[${mode}]\n${output}`)
    expect(code).toBe(0)
    expect(Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0)).toBeGreaterThan(0)
    expect(output).toContain('0 fail')
  }
}, 90_000)
