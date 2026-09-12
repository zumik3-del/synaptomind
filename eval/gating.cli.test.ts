import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// CLI-level verification of the #139 gating fix.
//
// The real `eval/thresholds.json` is never touched: every case stages a copy of
// the eval sources plus its own thresholds file in a temp directory inside the
// repo (so `../src/*` still resolves) and runs the actual CLI. Deterministic
// mode needs no model, so this stays hermetic and gives the end-to-end proof the
// unit tests cannot: the process exit code and operator-facing messages.

const EVAL_DIR = import.meta.dir
const REPO_ROOT = join(EVAL_DIR, '..')
const STUB_EMBEDDER = join(EVAL_DIR, '__fixtures__', 'stub-embedder-384.ts')
const SOURCE_FILES = [
  'index.ts',
  'runner.ts',
  'metrics.ts',
  'embedding.ts',
  'seed.ts',
  'search.ts',
  'types.ts'
] as const

interface StagedEval {
  dir: string
  out: string
}

interface Report {
  regressions: Array<Record<string, unknown>>
}

function datasetSource(scenarios: unknown[]): string {
  return [
    "import type { EvalScenario } from './types'",
    '',
    `export const EVAL_SCENARIOS: EvalScenario[] = ${JSON.stringify(scenarios, null, 2)}`,
    ''
  ].join('\n')
}

function thresholdEntry(mode: 'deterministic' | 'real', floor: number): unknown {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode,
    baseline: {
      overall: { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 0 },
      categories: {}
    },
    thresholds: {
      overall: { recall: floor, precision: floor, mrr: floor, hitRate: floor },
      categories: {}
    }
  }
}

function stageEval(scenarios: unknown[], modes: Record<string, unknown>): StagedEval {
  const dir = mkdtempSync(join(REPO_ROOT, '.eval-gating-'))
  for (const file of SOURCE_FILES) cpSync(join(EVAL_DIR, file), join(dir, file))
  writeFileSync(join(dir, 'datasets.ts'), datasetSource(scenarios))
  writeFileSync(join(dir, 'thresholds.json'), `${JSON.stringify({ version: 1, modes }, null, 2)}\n`)
  return { dir, out: join(dir, 'report.json') }
}

function runCli(
  staged: StagedEval,
  args: string[] = [],
  env: Record<string, string> = {}
): { status: number | null; output: string } {
  const res = spawnSync('bun', ['run', join(staged.dir, 'index.ts'), ...args, '--out', staged.out], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env }
  })
  return { status: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` }
}

function readReport(staged: StagedEval): Report {
  return JSON.parse(readFileSync(staged.out, 'utf8')) as Report
}

const CLEAN_SCENARIO = [
  {
    name: 'clean',
    category: 'explicit-fact',
    description: 'a single distinctive fact is retrieved',
    thoughts: [{ id: 'only', content: 'distinctive zanzibar lighthouse fact' }],
    queries: [{ query: 'zanzibar lighthouse', relevant: ['only'] }]
  }
]

const BROKEN_SCENARIO = [
  {
    name: 'broken',
    category: 'explicit-fact',
    description: 'duplicate content forces the forbidden thought to be retrieved',
    thoughts: [
      { id: 'dup-a', content: 'identical duplicate content token' },
      { id: 'dup-b', content: 'identical duplicate content token' }
    ],
    queries: [
      { query: 'identical duplicate content token', relevant: ['dup-a'], forbid: ['dup-b'] }
    ]
  }
]

describe('eval CLI gating (subprocess, temp thresholds)', () => {
  test('no baseline: a failing non-xfail assertion exits 1 and reports the assertion regression', () => {
    const staged = stageEval(BROKEN_SCENARIO, {})
    try {
      const { status, output } = runCli(staged)

      expect(status, output).toBe(1)
      expect(output).toContain('metric gating disabled')
      expect(output).not.toMatch(/satisfied/i)
      expect(output).toContain('scenario:broken')

      const regressions = readReport(staged).regressions
      expect(regressions).toHaveLength(1)
      expect(regressions[0]).toMatchObject({
        scope: 'scenario:broken',
        metric: 'assertion',
        actual: 0,
        threshold: 1
      })
    } finally {
      rmSync(staged.dir, { recursive: true, force: true })
    }
  })

  test('no baseline for the mode: metric shortfalls do not gate when only another mode has an entry', () => {
    const staged = stageEval(CLEAN_SCENARIO, { real: thresholdEntry('real', 2) })
    try {
      const { status, output } = runCli(staged)

      expect(status, output).toBe(0)
      expect(output).toContain('metric gating disabled')
      expect(output).not.toMatch(/satisfied/i)
      expect(readReport(staged).regressions).toEqual([])
    } finally {
      rmSync(staged.dir, { recursive: true, force: true })
    }
  })

  test('baseline present: metric shortfalls exit 1 without any assertion regression', () => {
    const staged = stageEval(CLEAN_SCENARIO, { deterministic: thresholdEntry('deterministic', 2) })
    try {
      const { status, output } = runCli(staged)

      expect(status, output).toBe(1)
      expect(output).not.toContain('metric gating disabled')

      const regressions = readReport(staged).regressions
      expect(regressions.map(regression => regression.scope)).toEqual([
        'overall',
        'overall',
        'overall',
        'overall'
      ])
      expect(regressions.every(regression => regression.metric !== 'assertion')).toBe(true)
    } finally {
      rmSync(staged.dir, { recursive: true, force: true })
    }
  })

  test('--real without a real baseline: a failing assertion still exits 1 (stub embedder)', () => {
    const staged = stageEval(BROKEN_SCENARIO, {})
    try {
      const { status, output } = runCli(staged, ['--real'], {
        SYNAPTOMIND_EMBEDDER_SCRIPT: STUB_EMBEDDER
      })

      expect(status, output).toBe(1)
      expect(output).toContain('metric gating disabled')
      expect(output).not.toMatch(/satisfied/i)

      const regressions = readReport(staged).regressions
      expect(regressions).toHaveLength(1)
      expect(regressions[0]).toMatchObject({ scope: 'scenario:broken', metric: 'assertion' })
    } finally {
      rmSync(staged.dir, { recursive: true, force: true })
    }
  })
})
