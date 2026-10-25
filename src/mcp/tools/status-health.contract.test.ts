/**
 * Contract test for `memory_status action=health` (task #1962).
 *
 * The `duplicate_drafts` finding is registered on the service side; this pins
 * the surface an operator actually sees: the finding reaches the MCP report with
 * severity `warning`, and `fix=true` must not repair it (a duplicate draft needs
 * a human merge/archive decision — it is the one content check with no autofix).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb, getDb } from '../../db'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerMemoryStatus } from './status'

interface CheckEntry {
  name: string
  severity: 'critical' | 'warning' | 'info'
  count: number
  details: Array<Record<string, unknown>>
  auto_fixable?: boolean
}

interface HealthReportShape {
  categories: Array<{ name: string; checks: CheckEntry[] }>
}

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerMemoryStatus(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

/** The report lives in the shared envelope's `item` (task #2179). */
function parseHealth(result: unknown): { report: HealthReportShape; meta: { action: string }; isError: boolean } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const parsed = JSON.parse(r.content?.[0]?.text ?? '{}') as { item: HealthReportShape; meta: { action: string } }
  return { report: parsed.item, meta: parsed.meta, isError: r.isError === true }
}

/** The `duplicate_drafts` check from a health report. */
function duplicateDraftCheck(report: HealthReportShape): CheckEntry {
  const contentCat = report.categories.find(c => c.name === 'content_quality')!
  return contentCat.checks.find(c => c.name === 'duplicate_drafts')!
}

beforeEach(async () => {
  createTestDb()
  client = await setupClient()
})

afterEach(closeDb)

test('memory_status action=health surfaces duplicate_drafts as a warning with the draft pair', async () => {
  const active = seedThought({ content: 'alpha beta gamma delta', status: 'active' })
  const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

  const result = await client.callTool({ name: 'memory_status', arguments: { action: 'health', include_details: true } })
  const { report, isError } = parseHealth(result)

  expect(isError).toBe(false)
  const check = duplicateDraftCheck(report)
  expect(check.severity).toBe('warning')
  expect(check.count).toBe(1)
  expect(check.details).toEqual([expect.objectContaining({ draft_id: draft, duplicate_of: active })])
})

test('fix=true does not repair duplicate_drafts — the count stays the same', async () => {
  const db = getDb()
  // Unprotected on purpose: a repair hook would really delete them, so the
  // count assertion below pins the absence of a repair rather than a guard.
  const active = seedThought({ content: 'alpha beta gamma delta', status: 'active', is_protected: 0 })
  const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', is_protected: 0 })

  const before = parseHealth(await client.callTool({ name: 'memory_status', arguments: { action: 'health' } }))
  expect(duplicateDraftCheck(before.report).count).toBe(1)

  await client.callTool({ name: 'memory_status', arguments: { action: 'health' } })

  const after = parseHealth(await client.callTool({ name: 'memory_status', arguments: { action: 'health' } }))
  expect(duplicateDraftCheck(after.report).count).toBe(1)
  // Neither side was merged, archived or deleted.
  expect(db.prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }).toEqual({ n: 2 })
  const rows = db.prepare('SELECT id, status FROM thoughts ORDER BY id').all() as Array<{ id: string; status: string }>
  expect(rows).toEqual(
    [
      { id: active, status: 'active' },
      { id: draft, status: 'draft' }
    ].sort((a, b) => a.id.localeCompare(b.id))
  )
})

test('a clean DB reports no duplicate_drafts', async () => {
  const result = await client.callTool({ name: 'memory_status', arguments: { action: 'health' } })
  const { report, isError } = parseHealth(result)

  expect(isError).toBe(false)
  expect(duplicateDraftCheck(report).count).toBe(0)
})

test('memory_status action=health rejects a legacy fix flag', async () => {
  const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const before = parseHealth(await client.callTool({ name: 'memory_status', arguments: { action: 'health' } }))
  const emptyBefore = before.report.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  expect(emptyBefore.count).toBe(1)

  // A legacy `fix` flag is a retired parameter and must fail input validation
  // instead of being silently stripped.
  const rejected = await client.callTool({ name: 'memory_status', arguments: { action: 'health', fix: true } })
  expect(rejected.isError).toBe(true)

  const after = parseHealth(await client.callTool({ name: 'memory_status', arguments: { action: 'health' } }))
  const emptyAfter = after.report.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  expect(emptyAfter.count).toBe(1)

  const db = getDb()
  const row = db.prepare('SELECT status FROM thoughts WHERE id = ?').get(clusterId) as { status: string }
  expect(row.status).toBe('active')
})
