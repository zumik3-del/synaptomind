#!/usr/bin/env bun
// CLI entry point: runs the harness, prints a human-readable table, writes a
// JSON report and exits non-zero only on threshold regressions.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildThresholdEntry,
  collectGatingRegressions,
  type EvalMode,
  loadThresholds,
  type Regression,
  type RunResult,
  runEval,
  type ThresholdFile,
  upsertThresholdEntry,
  writeThresholds
} from './runner'

interface CliOptions {
  mode: EvalMode
  topK?: number
  out: string
  updateBaseline: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'deterministic',
    out: join(import.meta.dir, 'report.json'),
    updateBaseline: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--real') options.mode = 'real'
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--top-k') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10)
      if (Number.isFinite(parsed) && parsed > 0) options.topK = parsed
    } else if (arg === '--out') options.out = argv[++i] ?? options.out
  }
  return options
}

function helpText(): string {
  return [
    'Usage: bun run eval [options]',
    '',
    'Options:',
    '  --real              use the production embedder + search service (downloads/loads the model)',
    '  --top-k <n>         default top-k when a query does not set its own (default: 5)',
    '  --out <path>        JSON report path (default: eval/report.json)',
    '  --update-baseline   recompute eval/thresholds.json from the current run',
    '  --help, -h          show this help',
    '',
    "Scenarios marked xfail (supersession, contradiction) are reported but never fail the run."
  ].join('\n')
}

function fmt(value: number): string {
  return value.toFixed(3)
}

function renderTable(result: RunResult): string {
  const header = ['scenario', 'category', 'nq', 'recall', 'prec', 'mrr', 'hit', 'status']
  const rows: string[][] = result.scenarios.map(scenario => [
    scenario.name,
    scenario.category,
    String(scenario.metrics.queries),
    fmt(scenario.metrics.recall),
    fmt(scenario.metrics.precision),
    fmt(scenario.metrics.mrr),
    fmt(scenario.metrics.hitRate),
    scenario.status
  ])
  rows.push([
    'OVERALL (non-xfail)',
    '-',
    String(result.overall.queries),
    fmt(result.overall.recall),
    fmt(result.overall.precision),
    fmt(result.overall.mrr),
    fmt(result.overall.hitRate),
    ''
  ])

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => row[index].length))
  )
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')

  const lines = [renderRow(header), widths.map(width => '-'.repeat(width)).join('  ')]
  for (const row of rows) lines.push(renderRow(row))

  lines.push('', 'Categories (non-xfail):')
  for (const [category, metrics] of Object.entries(result.categories)) {
    lines.push(
      `  ${category.padEnd(20)} nq=${String(metrics.queries).padEnd(3)} ` +
        `recall=${fmt(metrics.recall)} prec=${fmt(metrics.precision)} ` +
        `mrr=${fmt(metrics.mrr)} hit=${fmt(metrics.hitRate)}`
    )
  }
  return lines.join('\n')
}

function printRegressions(regressions: Regression[]): void {
  console.error('\nGating regressions:')
  for (const regression of regressions) {
    const detail = regression.detail ? ` (${regression.detail})` : ''
    console.error(
      `  ${regression.scope} ${regression.metric}: actual=${regression.actual} ` +
        `threshold=${regression.threshold}${detail}`
    )
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(helpText())
    return
  }

  const thresholdsPath = join(import.meta.dir, 'thresholds.json')
  const result = await runEval({ mode: options.mode, topK: options.topK })
  console.log(renderTable(result))

  const file: ThresholdFile = loadThresholds(thresholdsPath) ?? { version: 1, modes: {} }
  if (options.updateBaseline) {
    writeThresholds(thresholdsPath, upsertThresholdEntry(file, buildThresholdEntry(result)))
    console.log(`\n${options.mode} baseline + thresholds written to ${thresholdsPath}`)
  }

  const entry = options.updateBaseline ? null : (file.modes[options.mode] ?? null)
  if (!options.updateBaseline && !entry) {
    console.warn(
      `\nwarning: no "${options.mode}" thresholds in ${thresholdsPath}; metric gating disabled`
    )
  }
  // Hard assertions gate regardless of a baseline; metric regressions only when
  // an entry exists. `--update-baseline` is a recording run: never gate it.
  const regressions = options.updateBaseline ? [] : collectGatingRegressions(result, entry)
  if (!options.updateBaseline && regressions.length > 0) {
    printRegressions(regressions)
  } else if (!options.updateBaseline) {
    console.log('\nNo gating regressions.')
  }

  const report = { ...result, thresholds: thresholdsPath, regressions }
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`report written to ${options.out}`)

  if (options.mode === 'real') {
    const { stopEmbedderProcess } = await import('../src/embedder/client')
    await stopEmbedderProcess()
  }

  // The real embedder child process can keep the event loop alive after
  // teardown; exit explicitly so CI runs terminate deterministically.
  process.exit(regressions.length > 0 ? 1 : 0)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
