import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { closeDb } from '../db/init'
import { detectIssues } from './self-improve-detect'
import type { TelemetrySignals } from './self-improve-telemetry'
import { runSelfImproveJob, getLastSelfImproveStatus } from './self-improve.service'

beforeEach(createTestDb)
afterEach(closeDb)

function makeSignals(overrides: Partial<TelemetrySignals> = {}): TelemetrySignals {
  return {
    orphanRate: 0,
    totalWrites: 0,
    activationRate: 1,
    draftCreates: 0,
    archives: 0,
    highHitThoughts: [],
    searchCreateRatio: 1,
    clusterOps: 0,
    ...overrides
  }
}

// ── detectIssues ─────────────────────────────────────────────────────────────

test('detectIssues returns empty for clean signals', () => {
  expect(detectIssues(makeSignals())).toEqual([])
})

test('detectIssues detects orphan_writes_high', () => {
  const issues = detectIssues(makeSignals({ totalWrites: 10, orphanRate: 0.8 }))
  expect(issues.some(i => i.id === 'orphan_writes_high')).toBeTrue()
})

test('detectIssues does not trigger orphan_writes with low totalWrites', () => {
  const issues = detectIssues(makeSignals({ totalWrites: 3, orphanRate: 0.9 }))
  expect(issues.some(i => i.id === 'orphan_writes_high')).toBeFalse()
})

test('detectIssues detects low_activation_rate', () => {
  const issues = detectIssues(makeSignals({ draftCreates: 10, activationRate: 0.1 }))
  expect(issues.some(i => i.id === 'low_activation_rate')).toBeTrue()
})

test('detectIssues detects zero_clusters', () => {
  const issues = detectIssues(makeSignals({ totalWrites: 5, clusterOps: 0 }))
  expect(issues.some(i => i.id === 'zero_clusters')).toBeTrue()
})

test('detectIssues does not trigger zero_clusters with no writes', () => {
  const issues = detectIssues(makeSignals({ totalWrites: 0, clusterOps: 0 }))
  expect(issues.some(i => i.id === 'zero_clusters')).toBeFalse()
})

test('detectIssues detects high_archive_rate', () => {
  const issues = detectIssues(makeSignals({ draftCreates: 4, archives: 3 }))
  expect(issues.some(i => i.id === 'high_archive_rate')).toBeTrue()
})

test('detectIssues detects frequent_unpromoted', () => {
  const issues = detectIssues(makeSignals({
    highHitThoughts: [
      { id: 'a', hit_count: 20 },
      { id: 'b', hit_count: 15 }
    ]
  }))
  expect(issues.some(i => i.id === 'frequent_unpromoted')).toBeTrue()
})

test('detectIssues returns correct severity levels', () => {
  const issues = detectIssues(makeSignals({
    totalWrites: 10,
    orphanRate: 0.8,
    draftCreates: 10,
    activationRate: 0.1,
    clusterOps: 0,
    highHitThoughts: [{ id: 'x', hit_count: 50 }]
  }))
  const orphan = issues.find(i => i.id === 'orphan_writes_high')
  expect(orphan?.severity).toBe('action')
  const zero = issues.find(i => i.id === 'zero_clusters')
  expect(zero?.severity).toBe('warn')
})

// ── runSelfImproveJob ────────────────────────────────────────────────────────

test('runSelfImproveJob dry run returns issues without actions', async () => {
  const result = await runSelfImproveJob({ dryRun: true })
  expect(result.dry_run).toBeTrue()
  expect(result.issues).toBeArray()
  expect(result.actions_taken).toBeArray()
  expect(result.timestamp).toBeString()
})

test('runSelfImproveJob non-dry returns result with signals', async () => {
  const result = await runSelfImproveJob({ dryRun: true })
  expect(result.signals).toBeDefined()
  expect(result.signals.orphanRate).toBeNumber()
  expect(result.signals.totalWrites).toBeNumber()
})

test('getLastSelfImproveStatus returns null when no runs exist', () => {
  const status = getLastSelfImproveStatus()
  expect(status.last_run).toBeNull()
  expect(status.result).toBeNull()
})
