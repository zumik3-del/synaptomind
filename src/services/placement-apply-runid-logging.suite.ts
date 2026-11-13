import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { insertPendingEdge, NOW } from '../test/proposal-apply-helpers'
import type { ApplyResult } from './placement-apply.types'

const realLog = await import('../logging/log')
type InsertLogFn = typeof realLog.insertLog
type LogLevel = Parameters<InsertLogFn>[0]
type LogMetadata = Parameters<InsertLogFn>[3]

type LogCall = { level: LogLevel; type: string; message: string; metadata: LogMetadata }

const calls: LogCall[] = []

mock.module('../logging/log', () => ({
  ...realLog,
  insertLog: (
    level: LogLevel,
    type: string,
    message: string,
    metadata?: Record<string, unknown>
  ): void => {
    calls.push({ level, type, message, metadata })
  }
}))

const { applyBatchService, applyProposalService } = await import('./placement-apply.service')

beforeEach(() => {
  createTestDb()
  calls.length = 0
})

afterEach(() => {
  calls.length = 0
  closeDb()
})

function placementLogs(): LogCall[] {
  return calls.filter(c => c.type === 'placement')
}

function runIdLogs(): LogCall[] {
  return placementLogs().filter(
    c => typeof c.metadata?.run_id === 'string' && c.metadata.run_id !== ''
  )
}

function clearLogs(): void {
  calls.length = 0
}

function activePair(_db: Database, prefix: string): { source: string; target: string } {
  return {
    source: seedThought({ id: `${prefix}-s`, content: `${prefix} source`, created_at: NOW }),
    target: seedThought({ id: `${prefix}-t`, content: `${prefix} target`, created_at: NOW })
  }
}

function storedRunId(db: Database, id: string): string | null {
  const row = db.prepare('SELECT run_id FROM placement_proposals WHERE id = ?').get(id) as
    | { run_id: string | null }
    | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row.run_id
}

function logFor(proposalId: string): LogCall {
  const matching = placementLogs().filter(c => c.metadata?.proposal_id === proposalId)
  expect(matching).toHaveLength(1)
  return matching[0]!
}

/**
 * Prove the spy is live in THIS test before asserting that nothing was logged.
 * A silently unmocked writer (with no spy) would make every "no line"
 * assertion pass for the wrong reason;
 * a confirming apply must file a run-id line first. The witness clears the
 * record so the caller then observes only its own scenario.
 */
function expectSpyLive(db: Database, prefix: string): void {
  const { source, target } = activePair(db, prefix)
  const row = insertPendingEdge(db, source, target, 'develops')
  const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
  expect(out.status).toBe('accepted')
  expect(runIdLogs()).toHaveLength(1)
  clearLogs()
}

describe('AC-F28-8: the main accept log line carries the run envelope', () => {
  test('a synthesized envelope is logged, and is the same id as the row and the result', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log1')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >

    expect(out.status).toBe('accepted')
    expect(placementLogs()).toHaveLength(1)
    const line = logFor(row.id)
    expect(line.level).toBe('info')
    expect(line.message).toContain(`Applied placement proposal ${row.id}`)
    const logged = line.metadata?.run_id
    expect(logged).toBe(out.run_id)
    expect(logged).toBe(storedRunId(db, row.id))
    expect(String(logged).startsWith('auto-')).toBe(true)
    expect(line.metadata?.item_kind).toBe('edge')
  })

  test('the idempotent accept line carries the envelope too', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log2')
    seedEdge(source, target, 'develops')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >

    expect(out.status).toBe('accepted')
    expect((out as { idempotent: boolean }).idempotent).toBe(true)
    expect(placementLogs()).toHaveLength(1)
    const line = logFor(row.id)
    expect(line.message).toContain('(idempotent)')
    expect(line.metadata?.run_id).toBe(out.run_id)
    expect(String(out.run_id).startsWith('auto-')).toBe(true)
  })
})

describe('AC-F28-8: a caller-supplied run_id is logged verbatim', () => {
  test('the accept line reports the caller id, not a synthesized one', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log3')
    const row = insertPendingEdge(db, source, target, 'develops')

    applyProposalService(row.id, { confirm: true, now: NOW, runId: 'run-caller-42' }, db)

    expect(placementLogs()).toHaveLength(1)
    const line = logFor(row.id)
    expect(line.metadata?.run_id).toBe('run-caller-42')
    expect(line.metadata?.run_id).toBe(storedRunId(db, row.id))
    expect(String(line.metadata?.run_id).startsWith('auto-')).toBe(false)
  })

  test('a caller id that looks synthesized is still logged as given (prefix is advisory)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log4')
    const row = insertPendingEdge(db, source, target, 'develops')
    const callerId = 'auto-not-really-synthesized'

    applyProposalService(row.id, { confirm: true, now: NOW, runId: callerId }, db)

    expect(logFor(row.id).metadata?.run_id).toBe(callerId)
  })
})

describe('AC-F28-8: a batch logs one shared envelope for every item', () => {
  test('both accept lines carry the batch envelope, and each names its own row', () => {
    const db = getDb()
    const first = activePair(db, 'log5-a')
    const second = activePair(db, 'log5-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatchService([rowA.id, rowB.id], { confirm: true, now: NOW }, db)

    const shared = out.run_id ?? null
    expect(typeof shared).toBe('string')
    expect(placementLogs()).toHaveLength(2)
    expect(runIdLogs()).toHaveLength(2)
    expect(logFor(rowA.id).metadata?.run_id).toBe(shared)
    expect(logFor(rowB.id).metadata?.run_id).toBe(shared)
    expect(storedRunId(db, rowA.id)).toBe(shared)
    expect(storedRunId(db, rowB.id)).toBe(shared)
  })
})

describe('AC-F28-8: refusals and previews log no run envelope', () => {
  test('a dry-run logs nothing, so a preview cannot be mistaken for a commit', () => {
    const db = getDb()
    expectSpyLive(db, 'log7-witness')
    const { source, target } = activePair(db, 'log7')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposalService(row.id, { confirm: false, now: NOW }, db)

    expect(out.status).toBe('dry_run')
    expect('run_id' in out).toBe(false)
    expect(runIdLogs()).toHaveLength(0)
    expect(placementLogs()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('a stale item is announced, but its warning carries no run id', () => {
    const db = getDb()
    expectSpyLive(db, 'log8-witness')
    const { source, target } = activePair(db, 'log8')
    db.prepare("UPDATE thoughts SET status = 'archived' WHERE id = ?").run(target)
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)

    expect(out.status).toBe('stale')
    const warnings = placementLogs().filter(c => c.level === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain(row.id)
    expect(runIdLogs()).toHaveLength(0)
    expect(storedRunId(db, row.id)).toBeNull()
  })
})
