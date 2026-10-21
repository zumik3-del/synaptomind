import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { closeLogDb } from '../logging/log'
import { createTestDb, seedThought } from '../test/helpers'
import { detectIssues } from './self-improve-detect'
import type { SelfImproveSignals } from './self-improve-detect'
import { runSelfImproveJob, getLastSelfImproveStatus } from './self-improve.service'

// Coverage for the telemetry cut (ADR 2026-10-21, Q3): self-improve keeps
// exactly one detection — `frequent_unpromoted`, computed from `hit_count` in
// the MAIN db — and the four telemetry-derived detections
// (`orphan_writes_high`, `low_activation_rate`, `zero_clusters`,
// `high_archive_rate`) are gone together with the signal layer that fed them.
// The tests below pin both halves: the surviving detection still fires, and the
// removed ones can no longer be produced by any input.

/** The detections the cut removed — none of them may ever be reported again. */
const REMOVED_DETECTIONS = ['orphan_writes_high', 'low_activation_rate', 'zero_clusters', 'high_archive_rate']

/** The `selfImprove` config keys whose only readers died with the detections. */
const REMOVED_CONFIG_KEYS = ['orphanThreshold', 'activationThreshold', 'maxPromotesPerRun', 'maxMergesPerRun']

beforeEach(createTestDb)
afterEach(closeDb)

function makeSignals(overrides: Partial<SelfImproveSignals> = {}): SelfImproveSignals {
  return {
    highHitThoughts: [],
    ...overrides
  }
}

/** Give a thought a hit_count above the configured threshold. */
function seedHighHitThought(hitCount: number): string {
  const id = seedThought({ content: 'frequently hit thought' })
  getDb().prepare(`UPDATE thought_importance SET hit_count = ? WHERE thought_id = ?`).run(hitCount, id)
  return id
}

// ── detectIssues ─────────────────────────────────────────────────────────────

test('detectIssues returns empty for clean signals', () => {
  expect(detectIssues(makeSignals())).toEqual([])
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
    highHitThoughts: [{ id: 'x', hit_count: 50 }]
  }))
  const unpromoted = issues.find(i => i.id === 'frequent_unpromoted')
  expect(unpromoted?.severity).toBe('action')
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
  expect(result.signals.highHitThoughts).toBeArray()
})

test('getLastSelfImproveStatus returns null when no runs exist', () => {
  const status = getLastSelfImproveStatus()
  expect(status.last_run).toBeNull()
  expect(status.result).toBeNull()
})

// ── the one surviving detection ───────────────────────────────────────────────

test('runSelfImproveJob reports frequent_unpromoted for a thought above the hit threshold', async () => {
  const threshold = config.selfImprove.hitsThreshold
  const thoughtId = seedHighHitThought(threshold + 1)

  const result = await runSelfImproveJob({ dryRun: true })

  expect(result.issues).toHaveLength(1)
  expect(result.issues[0].id).toBe('frequent_unpromoted')
  expect(result.signals.highHitThoughts.map(h => h.id)).toContain(thoughtId)
})

test('runSelfImproveJob reports no issue for a thought below the hit threshold', async () => {
  seedHighHitThought(Math.max(0, config.selfImprove.hitsThreshold - 1))

  const result = await runSelfImproveJob({ dryRun: true })

  expect(result.issues).toEqual([])
})

test('the surviving detection does not need the log db', async () => {
  // ADR 2026-10-21 Q3: `frequent_unpromoted` is computed from `hit_count` in
  // the MAIN db, so the job no longer reads the log db for its detection. Before
  // the cut the whole signal layer came from the log db — with no log db the
  // job detected nothing at all.
  const originalLogDbPath = config.logDbPath
  config.logDbPath = ''
  closeLogDb()
  try {
    seedHighHitThought(config.selfImprove.hitsThreshold + 1)

    const result = await runSelfImproveJob({ dryRun: true })

    expect(result.issues.map(i => i.id)).toEqual(['frequent_unpromoted'])
  } finally {
    config.logDbPath = originalLogDbPath
    closeLogDb()
  }
})

// ── the removed detections can no longer be produced ───────────────────────────

test('detectIssues never reports one of the removed detections, whatever the input', () => {
  // The old signal layer fed the four removed detections with these counters;
  // they are no longer part of the signals, and an input that carries them must
  // not resurrect the detections.
  const hostileSignals = {
    highHitThoughts: [{ id: 'a', hit_count: 999 }],
    orphanRate: 1,
    totalWrites: 1000,
    activationRate: 0,
    draftCreates: 500,
    archives: 500,
    clusterOps: 500,
    searchCreateRatio: 0
  } as unknown as SelfImproveSignals

  const issues = detectIssues(hostileSignals)
  const ids = issues.map(i => i.id)

  for (const removed of REMOVED_DETECTIONS) {
    expect(ids).not.toContain(removed)
  }
  // The only id that may come out is the survivor.
  expect(new Set(ids)).toEqual(new Set(['frequent_unpromoted']))
})

test('the run result carries only the surviving signal', async () => {
  seedHighHitThought(config.selfImprove.hitsThreshold + 1)

  const result = await runSelfImproveJob({ dryRun: true })

  expect(Object.keys(result.signals)).toEqual(['highHitThoughts'])
})

test('the removed detection ids are gone from the self-improve sources', () => {
  const sources = ['self-improve-detect.ts', 'self-improve.service.ts']
    .map(file => readFileSync(join(import.meta.dir, file), 'utf8'))

  for (const removed of REMOVED_DETECTIONS) {
    for (const source of sources) {
      expect(source).not.toContain(removed)
    }
  }
})

test('the removed selfImprove config keys are gone from the config schema', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'config.ts'), 'utf8')

  for (const key of REMOVED_CONFIG_KEYS) {
    expect(source).not.toContain(key)
  }
  for (const key of REMOVED_CONFIG_KEYS) {
    expect(key in config.selfImprove).toBe(false)
  }
})
