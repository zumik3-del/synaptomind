import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The default harness mode must never start the embedder child process. We
// prove it by pointing the client at a stub that writes a sentinel file on
// startup: if the default run created the sentinel, a child was spawned.
const REPO_ROOT = join(import.meta.dir, '..')
const CLI = join(import.meta.dir, 'index.ts')
const STUB_EMBEDDER = join(import.meta.dir, '__fixtures__', 'stub-embedder-384.ts')

function runCli(args: string[], env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync('bun', ['run', CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180_000
  })
}

describe('eval harness isolation', () => {
  test('default mode exits 0 without starting the embedder child process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-isolation-default-'))
    const sentinel = join(dir, 'embedder-spawned')
    const out = join(dir, 'report.json')

    try {
      const res = runCli(['--out', out], {
        SYNAPTOMIND_EMBEDDER_SCRIPT: STUB_EMBEDDER,
        EVAL_STUB_SENTINEL: sentinel
      })

      expect(res.status, `${res.stderr}\n${res.stdout}`).toBe(0)
      expect(existsSync(sentinel)).toBe(false)

      const report = JSON.parse(readFileSync(out, 'utf8')) as { mode: string }
      expect(report.mode).toBe('deterministic')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--real mode starts the embedder child process and still runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-isolation-real-'))
    const sentinel = join(dir, 'embedder-spawned')
    const out = join(dir, 'report.json')

    try {
      const res = runCli(['--real', '--out', out], {
        SYNAPTOMIND_EMBEDDER_SCRIPT: STUB_EMBEDDER,
        EVAL_STUB_SENTINEL: sentinel
      })

      expect(res.status, `${res.stderr}\n${res.stdout}`).toBe(0)
      expect(existsSync(sentinel)).toBe(true)

      const report = JSON.parse(readFileSync(out, 'utf8')) as { mode: string }
      expect(report.mode).toBe('real')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
