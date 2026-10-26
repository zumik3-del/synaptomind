#!/usr/bin/env bun
// CLI entry point: runs the harness, prints a human-readable table, writes a
// JSON report and exits non-zero only on threshold regressions.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runEval, runEvalWithGate } from './runner'
import { buildThresholdEntry, collectGatingRegressions, loadThresholds, upsertThresholdEntry, writeThresholds, type ThresholdFile } from './thresholds'
import type { EvalMode, Regression, RunResult } from './types'

interface CliOptions {
  mode: EvalMode
  topK?: number
  out: string
  updateBaseline: boolean
  /** Report-only production-gate pass; `--no-gated` turns it off. */
  gated: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'deterministic',
    out: join(import.meta.dir, 'report.json'),
    updateBaseline: false,
    gated: true,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--real') options.mode = 'real'
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--no-gated') options.gated = false
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
    '  --no-gated          skip the report-only gated pass (one pass instead of two)',
    '  --help, -h          show this help',
    '',
    'Scenarios marked xfail (contradiction) are reported but never fail the run.',
    '',
    'Every run also prints a report-only second pass with the production relevance',
    'gate enabled (minRelevance as production resolves it). It never affects the',
    'exit code, thresholds or the regression list; the JSON report carries it under',
    '"gated". --no-gated skips that pass, halving the run (the ungated measurement,',
    'the baselines and the exit code are unaffected).'
  ].join('\n')
}

function fmt(value: number): string {
  return value.toFixed(3)
}

/** Renders a left-aligned fixed-width table (header, separator, rows). */
function renderGrid(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => row[index].length))
  )
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')

  const lines = [renderRow(header), widths.map(width => '-'.repeat(width)).join('  ')]
  for (const row of rows) lines.push(renderRow(row))
  return lines
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

  const lines = renderGrid(header, rows)

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

/**
 * Side-by-side view of the report-only gated pass (task #2191): the same
 * scenarios scored with the relevance gate production applies, next to the
 * ungated measurement the baselines gate on, plus the gate value and dropped-row
 * count so a recall loss is attributable rather than mysterious.
 */
function renderGatedPass(ungated: RunResult, gated: RunResult): string {
  const gate = gated.relevanceGate
  const gateLine = gate
    ? `  gate: minRelevance=${fmt(gate.minRelevance)} (production default) — dropped ` +
      `${gate.droppedRows} of ${gate.candidates} candidate rows across ` +
      `${gate.queriesWithDrops}/${gated.overall.queries} queries`
    : '  gate: unavailable (no gate bookkeeping on the pass)'
  const header = [
    'scenario',
    'recall off',
    'recall gated',
    'prec off',
    'prec gated',
    'mrr off',
    'mrr gated',
    'status gated'
  ]
  const gatedByName = new Map(gated.scenarios.map(scenario => [scenario.name, scenario]))
  const rows: string[][] = ungated.scenarios.map(scenario => {
    const other = gatedByName.get(scenario.name)
    return [
      scenario.name,
      fmt(scenario.metrics.recall),
      other ? fmt(other.metrics.recall) : '-',
      fmt(scenario.metrics.precision),
      other ? fmt(other.metrics.precision) : '-',
      fmt(scenario.metrics.mrr),
      other ? fmt(other.metrics.mrr) : '-',
      other?.status ?? '-'
    ]
  })
  rows.push([
    'OVERALL (non-xfail)',
    fmt(ungated.overall.recall),
    fmt(gated.overall.recall),
    fmt(ungated.overall.precision),
    fmt(gated.overall.precision),
    fmt(ungated.overall.mrr),
    fmt(gated.overall.mrr),
    ''
  ])

  return [
    '',
    'Relevance gate pass (report-only — never gates the exit code, thresholds or regressions)',
    gateLine,
    ...renderGrid(header, rows)
  ].join('\n')
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
  // Two passes over the same scenarios by default: the ungated one is the
  // measurement the baselines (and therefore the exit code) gate on; the gated
  // one is report-only visibility into what the production relevance gate costs.
  // `--no-gated` drops the second pass for a caller that does not read it (it is
  // half the run's embedding/search work and, in `--real`, half the model cost).
  const runOptions = { mode: options.mode, topK: options.topK }
  const passes = options.gated
    ? await runEvalWithGate(runOptions)
    : { ungated: await runEval(runOptions), gated: null }
  const result = passes.ungated
  console.log(renderTable(result))
  if (passes.gated) console.log(renderGatedPass(result, passes.gated))
  else console.log('\nGated pass skipped (--no-gated).')

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

  const report = {
    ...result,
    thresholds: thresholdsPath,
    regressions,
    ...(passes.gated ? { gated: passes.gated } : {})
  }
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
