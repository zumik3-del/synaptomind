import { expect, test } from 'bun:test'

const MODES = ['delegated', 'assigned-users']

test('embedder child spawn scope (isolated processes)', async () => {
  for (const mode of MODES) {
    const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-spawn-scope.suite.ts'], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, SYNAPTOMIND_SPAWN_SCOPE_MODE: mode },
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
    // A fully skipped suite also ends in "0 fail"; require real assertions to run.
    expect(Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0)).toBeGreaterThan(0)
    expect(output).toContain('0 fail')
  }
}, 90_000)
