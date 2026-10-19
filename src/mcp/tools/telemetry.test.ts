/**
 * Regression tests for task #1763 (audit M5): the MCP `memory_telemetry` action
 * `query` resolves its window and limit through the same per-metric policy as the
 * HTTP telemetry routes (`resolveTelemetryWindow` / `resolveTelemetryLimit`).
 *
 * Behaviour-level proofs (not unit restatements):
 *  - draft_lifecycle keeps its 30-day default window while frequency uses 24h,
 *  - patterns honours the per-metric default limit (10) and cap (50),
 *  - the unavailable-log-DB error text is unified with the HTTP 503 body.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config'
import { closeDb } from '../../db/init'
import { closeLogDb, getLogDb, insertTelemetry } from '../../logging'
import { createTestDb } from '../../test/helpers'
import { registerMemoryTelemetry } from './telemetry'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const originalLogDbPath = config.logDbPath

function useLogDb(path: string): void {
  closeLogDb()
  config.logDbPath = path
}

interface ToolResult {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

function parseResult(result: unknown): { text: string; isError: boolean; result: unknown } {
  const r = result as ToolResult
  return {
    text: r.content?.[0]?.text ?? '',
    isError: r.isError === true,
    result: r.structuredContent?.result
  }
}

/** Wrap registerMemoryTelemetry in a fake server and return the registered callback (same harness as action-tool.test.ts). */
function captureTelemetryHandler(): (args: Record<string, unknown>) => Promise<unknown> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      handler = cb
      return { enable: () => {}, disable: () => {}, remove: () => {} }
    }
  } as unknown as McpServer
  registerMemoryTelemetry(fakeServer)
  if (!handler) throw new Error('registerMemoryTelemetry did not register a tool')
  return handler
}

/** Backdated telemetry row: `insertTelemetry` always stamps `created_at = now`, windows need age. */
function insertAgedTelemetry(action: string, toolName: string, createdAt: string): void {
  getLogDb()!
    .prepare(
      'INSERT INTO thought_telemetry (id, action, tool_name, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(Bun.randomUUIDv7(), action, toolName, createdAt)
}

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString()

beforeEach(() => {
  createTestDb()
  useLogDb(':memory:')
})
afterEach(() => {
  closeDb()
  closeLogDb()
})
afterAll(() => {
  closeLogDb()
  config.logDbPath = originalLogDbPath
})

describe('memory_telemetry query window resolution', () => {
  test('draft_lifecycle keeps its 30-day default while frequency uses its 24h default', async () => {
    const query = captureTelemetryHandler()
    // Ten days old: inside draft_lifecycle's 30-day default, outside frequency's 24h default.
    insertAgedTelemetry('write', 'thought', TEN_DAYS_AGO)
    insertAgedTelemetry('read', 'search_thoughts', TEN_DAYS_AGO)
    insertTelemetry({ action: 'read', toolName: 'get_thought' })

    const draft = parseResult(await query({ action: 'query', metric: 'draft_lifecycle' }))
    expect(draft.isError).toBe(false)
    expect(draft.result).toEqual([{ action: 'write', count: 1 }])

    const frequency = parseResult(await query({ action: 'query', metric: 'frequency' }))
    expect(frequency.result).toEqual([{ action: 'read', count: 1 }])

    // The same metric with an explicit wide window does see the aged rows
    // (including the aged draft row, since frequency groups every action).
    const wide = parseResult(await query({ action: 'query', metric: 'frequency', window: 2_592_000 }))
    expect(wide.result).toEqual([
      { action: 'read', count: 2 },
      { action: 'write', count: 1 }
    ])
  })
})

describe('memory_telemetry query limit resolution', () => {
  test('patterns defaults to 10 rows and clamps an oversized limit to the 50 cap', async () => {
    const query = captureTelemetryHandler()
    for (let i = 0; i < 60; i++) {
      insertTelemetry({ action: 'read', toolName: `tool_${i}`, prevTool: `prev_${i}` })
    }

    const byDefault = parseResult(await query({ action: 'query', metric: 'patterns' }))
    expect(byDefault.isError).toBe(false)
    expect(byDefault.result as unknown[]).toHaveLength(10)

    const capped = parseResult(await query({ action: 'query', metric: 'patterns', limit: 999 }))
    expect(capped.result as unknown[]).toHaveLength(50)
  })
})

describe('memory_telemetry query failures', () => {
  test('an unavailable log database surfaces the unified error text', async () => {
    useLogDb('')
    const query = captureTelemetryHandler()

    const result = parseResult(await query({ action: 'query', metric: 'patterns' }))
    expect(result.isError).toBe(true)
    expect(result.text).toBe('Log database not available')
  })

  test('query without a metric is rejected by the action schema', async () => {
    const query = captureTelemetryHandler()

    const result = parseResult(await query({ action: 'query' }))
    expect(result.isError).toBe(true)
    expect(result.text).toBe('metric is required for query action')
  })
})
