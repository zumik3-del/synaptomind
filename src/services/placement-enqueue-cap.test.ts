import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The cap is read from a load-time singleton, so each scenario runs in its own process:
// `placement-enqueue-cap.suite.ts` loads one configured value and the wrapper spawns it per case.
const SUITE = './src/services/placement-enqueue-cap.suite.ts'
const REPO_ROOT = join(import.meta.dir, '..', '..')
const HELPERS = join(import.meta.dir, 'placement-proposals.helpers.service.ts')
const CAP_ENV = 'SYNAPTOMIND_PLACEMENT_MAX_PROPOSALS_PER_ENQUEUE'

function isolatedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('SYNAPTOMIND_') || key.startsWith('EMBEDDER_')) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}

interface Scenario {
  /** The value the scratch config.json carries. */
  configFile: string
  /** The value the load resolves to (the env layer, when present, wins over the file). */
  expectedConfig: string
  /** The cap the resolver returns for that config. */
  expectedCap: string
  callerCap: string
  env?: Record<string, string>
}

async function runSuite(scenario: Scenario): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['bun', 'test', SUITE], {
    cwd: REPO_ROOT,
    env: isolatedEnv({
      CAP_FILE: scenario.configFile,
      EXPECTED_CONFIG: scenario.expectedConfig,
      EXPECTED_CAP: scenario.expectedCap,
      CALLER_CAP: scenario.callerCap,
      ...scenario.env
    }),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { code, output: `${stdout}\n${stderr}` }
}

describe('resolveMaxProposalsPerEnqueue — the configured cap', () => {
  test('a configured 0 clamps to 1, and a caller-supplied max_proposals still wins', async () => {
    const { code, output } = await runSuite({
      configFile: '0',
      expectedConfig: '0',
      expectedCap: '1',
      callerCap: '3'
    })

    expect(output).toContain('0 fail')
    expect(code, output).toBe(0)
  }, 30_000)

  test('a negative configured value clamps to 1, and a caller-supplied max_proposals still wins', async () => {
    const { code, output } = await runSuite({
      configFile: '-4',
      expectedConfig: '-4',
      expectedCap: '1',
      callerCap: '2'
    })

    expect(output).toContain('0 fail')
    expect(code, output).toBe(0)
  }, 30_000)

  test('a valid env override is honoured, and a caller-supplied max_proposals still wins', async () => {
    const { code, output } = await runSuite({
      configFile: '0',
      expectedConfig: '9',
      expectedCap: '9',
      callerCap: '4',
      env: { [CAP_ENV]: '9' }
    })

    expect(output).toContain('0 fail')
    expect(code, output).toBe(0)
  }, 30_000)
})

describe('the cap has one configuration surface', () => {
  const source = readFileSync(HELPERS, 'utf8')

  test('the fallback is DEFAULTS.placement.maxProposalsPerEnqueue, never a second literal', () => {
    expect(source).toContain('DEFAULTS.placement.maxProposalsPerEnqueue')
    expect(source).not.toMatch(/return\s+5\b/)
  })

  test('the config read is the one declared key, with no retired alias beside it', () => {
    expect(source.match(/config\.placement\.maxProposalsPerEnqueue/g)).toHaveLength(1)
    for (const retired of ['cfgCandidates', 'config.edgeDetect', 'cfg.maxProposals']) {
      expect(source).not.toContain(retired)
    }
  })
})
