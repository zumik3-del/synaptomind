import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { closeLogDb, getLogDb, insertTelemetry } from '../logging'
import {
  countClusterOpEvents,
  countOrphanWriteEvents,
  countSearchCreateEvents,
  countWriteEvents,
} from './telemetry-queries'

const originalLogDbPath = config.logDbPath

function useLogDb(path: string): void {
  closeLogDb()
  config.logDbPath = path
}

const SINCE = new Date(Date.now() - 86_400_000).toISOString()

beforeEach(() => useLogDb(':memory:'))
afterEach(closeLogDb)
afterAll(() => {
  closeLogDb()
  config.logDbPath = originalLogDbPath
})

describe('countWriteEvents', () => {
  test('returns 0 when no events exist', () => {
    expect(countWriteEvents(getLogDb()!, SINCE)).toBe(0)
  })

  test('counts write actions', () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought' })
    insertTelemetry({ action: 'write', toolName: 'update_thought' })
    insertTelemetry({ action: 'read', toolName: 'search_thoughts' })
    expect(countWriteEvents(getLogDb()!, SINCE)).toBe(2)
  })
})

describe('countOrphanWriteEvents', () => {
  test('returns 0 when no events exist', () => {
    expect(countOrphanWriteEvents(getLogDb()!, SINCE)).toBe(0)
  })

  test('counts writes without grounding tools as orphan', () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought' })
    insertTelemetry({ action: 'write', toolName: 'update_thought', prevTool: 'search_thoughts' })
    expect(countOrphanWriteEvents(getLogDb()!, SINCE)).toBe(1)
  })

  test('does not count writes preceded by a grounding tool', () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought', prevTool: 'search_thoughts' })
    expect(countOrphanWriteEvents(getLogDb()!, SINCE)).toBe(0)
  })
})

describe('countSearchCreateEvents', () => {
  test('returns 0 when no events exist', () => {
    expect(countSearchCreateEvents(getLogDb()!, SINCE)).toBe(0)
  })

  test('counts writes preceded by search_thoughts', () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought', prevTool: 'search_thoughts' })
    insertTelemetry({ action: 'write', toolName: 'create_thought' })
    expect(countSearchCreateEvents(getLogDb()!, SINCE)).toBe(1)
  })
})

describe('countClusterOpEvents', () => {
  test('returns 0 when no events exist', () => {
    expect(countClusterOpEvents(getLogDb()!, SINCE)).toBe(0)
  })

  test('counts cluster-related tool invocations', () => {
    insertTelemetry({ action: 'link', toolName: 'cluster' })
    insertTelemetry({ action: 'link', toolName: 'auto_cluster' })
    insertTelemetry({ action: 'write', toolName: 'merge_thoughts' })
    insertTelemetry({ action: 'write', toolName: 'create_thought' })
    expect(countClusterOpEvents(getLogDb()!, SINCE)).toBe(3)
  })
})
