import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated load: `config` is a load-time singleton, so one process carries exactly one cap value and
// the wrapper (`placement-enqueue-cap.test.ts`) spawns this suite once per scenario.

const scratch = mkdtempSync(join(tmpdir(), 'synaptomind-enqueue-cap-'))
const configPath = join(scratch, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify({ placement: { maxProposalsPerEnqueue: Number(process.env.CAP_FILE) } })
)
process.env.SYNAPTOMIND_CONFIG = configPath

const { config, DEFAULTS } = await import('../config')
const { resolveMaxProposalsPerEnqueue } = await import('./placement-proposals.helpers.service')

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const EXPECTED_CONFIG = Number(process.env.EXPECTED_CONFIG)
const EXPECTED_CAP = Number(process.env.EXPECTED_CAP)
const CALLER_CAP = Number(process.env.CALLER_CAP)

test('the configured value this process loaded is the one under test', () => {
  expect(config.placement.maxProposalsPerEnqueue).toBe(EXPECTED_CONFIG)
})

test('the resolver clamps the configured value to the effective cap', () => {
  expect(resolveMaxProposalsPerEnqueue({})).toBe(EXPECTED_CAP)
})

test('a caller-supplied max_proposals wins over the configured cap', () => {
  expect(resolveMaxProposalsPerEnqueue({ max_proposals: CALLER_CAP })).toBe(CALLER_CAP)
})

test('the default the resolver falls back to is the documented one', () => {
  expect(DEFAULTS.placement.maxProposalsPerEnqueue).toBe(5)
})
