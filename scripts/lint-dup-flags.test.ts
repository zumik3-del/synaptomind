import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the flag surface `bun run lint:dup` and its CI step depend on: jscpd v5
// renamed `--exitCode` to `--exit-code` and the resulting usage error read as
// "clones found", so duplication detection was off on a green job (#2681). The
// script's flags are read from package.json and checked against the installed
// CLI, so a future rename fails here instead of silently disabling the check.

const REPO_ROOT = join(import.meta.dir, '..')

const ADVISORY_FLAGS: readonly string[] = [
  '--exit-code',
  '--fail-on-empty',
  '--threshold',
  '--min-lines',
  '--min-tokens',
  '--reporters'
]

function lintDupCommand(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const command = manifest.scripts?.['lint:dup']
  if (typeof command !== 'string') throw new Error('package.json has no lint:dup script')
  return command
}

function longFlags(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*)/g)].map(match => match[1])
}

function helpLists(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s,])${escaped}(?![A-Za-z0-9_-])`).test(help)
}

let helpOutput: string | undefined

function jscpdHelp(): string {
  if (helpOutput !== undefined) return helpOutput
  const binary = join(REPO_ROOT, 'node_modules', '.bin', 'jscpd')
  if (!existsSync(binary)) {
    throw new Error(`jscpd is not installed at ${binary} — run \`bun install\` first`)
  }
  const result = Bun.spawnSync([process.execPath, binary, '--help'], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
  if (result.exitCode !== 0) {
    throw new Error(`\`jscpd --help\` exited ${result.exitCode}: ${output.trim().slice(0, 500)}`)
  }
  helpOutput = output
  return output
}

describe('lint:dup flags', () => {
  test('extracts every long flag from a command line', () => {
    const command = 'jscpd src --min-lines 6 -i "**/*.test.ts" --exitCode=1 --fail-on-empty'
    expect(longFlags(command)).toEqual(['--min-lines', '--exitCode', '--fail-on-empty'])
  })

  test('matches flag tokens, not substrings', () => {
    expect(helpLists('  --exit-code [<EXIT_CODE>]', '--exit-code')).toBe(true)
    expect(helpLists('  --exit-code [<EXIT_CODE>]', '--exitCode')).toBe(false)
    expect(helpLists('  -l, --min-lines <MIN_LINES>', '--min-lines')).toBe(true)
    expect(helpLists('  -l, --min-lines <MIN_LINES>', '--min')).toBe(false)
  })

  test('every long flag the script passes is listed by the installed jscpd', () => {
    const flags = longFlags(lintDupCommand())
    expect(flags.length).toBeGreaterThan(0)
    const help = jscpdHelp()
    const missing = flags.filter(flag => !helpLists(help, flag))
    expect(
      missing,
      `lint:dup passes flags \`jscpd --help\` does not list: ${missing.join(', ')}`
    ).toEqual([])
  })

  test('the advisory-contract flags still exist', () => {
    const help = jscpdHelp()
    const missing = ADVISORY_FLAGS.filter(flag => !helpLists(help, flag))
    expect(missing, `jscpd --help no longer lists: ${missing.join(', ')}`).toEqual([])
  })
})
