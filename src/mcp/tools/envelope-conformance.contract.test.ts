import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb, closeDb } from '../../db'
import { resolveDefaultProjectId } from '../../db/projects'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

function stubEmbedding(text: string): Float32Array {
  const vector = new Float32Array(384)
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
  vector[Math.abs(hash) % vector.length] = 1
  return vector
}

mock.module('../../embedder/client', () => ({
  generateEmbedding: (text: string) => stubEmbedding(text),
  generateEmbeddings: (texts: string[]) => texts.map(stubEmbedding),
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

async function setupClient(): Promise<Client> {
  const s = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

interface ToolResult {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

function readResult(result: unknown): {
  payload: unknown
  isError: boolean
  text: string
  rawContent: unknown
} {
  const r = result as ToolResult
  const text = r.content?.[0]?.text ?? ''
  let parsedContent: unknown = text
  try {
    parsedContent = JSON.parse(text)
  } catch {}
  return {
    payload: r.structuredContent?.result,
    isError: r.isError === true,
    text,
    rawContent: parsedContent
  }
}

const CWD = '/tmp/opencode/conformance-project'
const PROJECT = 'proj-conformance'

interface Fixture {
  source: string
  target: string
  other: string
  edgeId: string
  retention: string
}

let fx: Fixture

const OLD_ISO = '2020-01-01T00:00:00.000Z'

function seedFixture(): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO projects (id, name, created_at, local_path) VALUES (?, 'Conformance', ?, ?)`
  ).run(PROJECT, new Date().toISOString(), CWD)

  const source = seedThought({
    content: 'conformance source alpha',
    tags: '["conformance"]',
    project_id: PROJECT
  })
  const target = seedThought({ content: 'conformance target beta', project_id: PROJECT })
  const other = seedThought({ content: 'conformance other delta', project_id: PROJECT })
  const retention = seedThought({
    content: 'conformance retention epsilon',
    status: 'archived',
    is_protected: 0,
    created_at: OLD_ISO,
    project_id: PROJECT
  })
  db.prepare('UPDATE thought_importance SET importance = 0.05 WHERE thought_id = ?').run(retention)

  fx = {
    source,
    target,
    other,
    edgeId: seedEdge(source, other, 'supports'),
    retention
  }
}

interface ActionCase {
  tool: string
  action: string
  metaAction?: string
  args: (f: Fixture) => Record<string, unknown>
  slot: 'item' | 'items' | 'graph'
  cwd?: boolean
  preview?: boolean
  noMirror?: boolean
  knownDefect?: string
}

const CASES: ActionCase[] = [
  {
    tool: 'memory_recall',
    action: 'search',
    args: () => ({ query: 'conformance source alpha' }),
    slot: 'items',
    cwd: true
  },
  { tool: 'memory_recall', action: 'get', args: f => ({ thought_id: f.source }), slot: 'item' },
  {
    tool: 'memory_recall',
    action: 'context',
    args: f => ({ thought_id: f.source }),
    slot: 'item',
    cwd: true
  },
  { tool: 'memory_recall', action: 'chain', args: f => ({ thought_id: f.source }), slot: 'item' },
  {
    tool: 'memory_recall',
    action: 'clusters',
    args: () => ({ query: 'conformance cluster' }),
    slot: 'items',
    cwd: true
  },
  { tool: 'memory_recall', action: 'list', args: () => ({}), slot: 'items', cwd: true },
  {
    tool: 'memory_store',
    action: 'create',
    args: () => ({ content: 'conformance created' }),
    slot: 'item',
    cwd: true
  },
  {
    tool: 'memory_store',
    action: 'update',
    args: f => ({ thought_id: f.source, content: 'conformance updated' }),
    slot: 'item',
    cwd: true
  },
  {
    tool: 'memory_store',
    action: 'link',
    args: f => ({ source_id: f.source, target_id: f.target }),
    slot: 'item'
  },
  {
    tool: 'memory_store',
    action: 'link_batch',
    args: f => ({ links: [{ source: f.source, target: f.target }] }),
    slot: 'items'
  },
  {
    tool: 'memory_store',
    action: 'unlink',
    args: f => ({ edge_id: f.edgeId }),
    slot: 'item',
    preview: true
  },
  {
    tool: 'memory_store',
    action: 'unlink_batch',
    args: f => ({ edge_ids: [f.edgeId] }),
    slot: 'items',
    preview: true
  },
  {
    tool: 'memory_store',
    action: 'retype',
    args: f => ({ edge_id: f.edgeId, new_type: 'related' }),
    slot: 'item',
    preview: true
  },
  {
    tool: 'memory_store',
    action: 'bulk_create',
    args: () => ({ thoughts: [{ content: 'conformance bulk' }] }),
    slot: 'items',
    cwd: true
  },
  {
    tool: 'memory_supersede',
    action: 'archive',
    args: f => ({ thought_id: f.target }),
    slot: 'item',
    preview: true
  },
  {
    tool: 'memory_supersede',
    action: 'archive_batch',
    args: f => ({ thought_ids: [f.target] }),
    slot: 'items',
    preview: true
  },
  {
    tool: 'memory_supersede',
    action: 'merge',
    args: f => ({ source_id: f.target, target_id: f.source }),
    slot: 'item',
    preview: true,
    cwd: true
  },
  { tool: 'memory_status', action: 'slots', args: () => ({}), slot: 'items', cwd: true },
  { tool: 'memory_status', action: 'frontier', args: () => ({}), slot: 'items', cwd: true },
  { tool: 'memory_status', action: 'config', args: () => ({}), slot: 'item', noMirror: true },
  { tool: 'memory_status', action: 'health', args: () => ({}), slot: 'item' },
  { tool: 'memory_manage', action: 'list', args: () => ({}), slot: 'items', cwd: true },
  {
    tool: 'memory_manage',
    action: 'create',
    args: () => ({ name: 'Conformance Created', local_path: '/tmp/opencode/conformance-created' }),
    slot: 'item',
    cwd: true
  },
  {
    tool: 'memory_manage',
    action: 'update',
    args: () => ({ project_id: PROJECT, name: 'Conformance renamed' }),
    slot: 'item',
    cwd: true
  },
  {
    tool: 'memory_manage',
    action: 'delete',
    args: () => ({ project_id: PROJECT }),
    slot: 'item',
    cwd: true,
    preview: true
  },
  { tool: 'memory_manage', action: 'resolve', args: () => ({}), slot: 'item', cwd: true },
  { tool: 'memory_crystallize', action: 'graph', args: () => ({}), slot: 'graph', cwd: true },
  {
    tool: 'memory_crystallize',
    action: 'cluster',
    args: f => ({ thought_ids: [f.source, f.target], title: 'conformance cluster' }),
    slot: 'item',
    cwd: true
  },
  {
    tool: 'memory_crystallize',
    action: 'auto_cluster',
    args: () => ({}),
    slot: 'items',
    preview: true
  },
  {
    tool: 'memory_reflect',
    action: 'reflect',
    args: () => ({ summary: 'conformance reflect' }),
    slot: 'item',
    cwd: true
  },
  {
    tool: 'memory_reflect',
    action: 'timeline',
    args: () => ({}),
    slot: 'items',
    cwd: true
  },
  { tool: 'memory_primers', action: 'list', args: () => ({}), slot: 'items' },
  {
    tool: 'memory_primers',
    action: 'delete',
    args: () => ({ primer_id: 'missing-primer' }),
    slot: 'item'
  },
  { tool: 'retention_review', action: 'list', args: () => ({}), slot: 'items' },
  {
    tool: 'retention_review',
    action: 'protect',
    args: f => ({ thought_id: f.retention }),
    slot: 'item'
  },
  {
    tool: 'retention_review',
    action: 'delete',
    args: f => ({ thought_id: f.retention }),
    slot: 'item',
    preview: true
  },
  {
    tool: 'retention_review',
    action: 'compact',
    args: f => ({ source_ids: [f.retention], summary: { content: 'conformance summary' } }),
    slot: 'item',
    preview: true
  }
]

const ACTION_TOOLS = [
  'memory_crystallize',
  'memory_manage',
  'memory_primers',
  'memory_recall',
  'memory_reflect',
  'memory_status',
  'memory_store',
  'memory_supersede',
  'retention_review'
]

const LEGACY_KEYS = ['thoughts', 'nodes', 'best_match', 'text', 'results', 'clusters', 'edges']

const BOOLEAN_FIELDS = new Set([
  'is_cluster',
  'is_protected',
  'is_global',
  'low_confidence',
  'degraded',
  'global',
  'destructive',
  'retryable',
  'truncated',
  'virtual',
  'auto_fixable',
  'review_required',
  'success'
])

const META_KEYS = new Set([
  'action',
  'scope',
  'counts',
  'degraded',
  'warnings',
  'reason',
  'preview'
])
const REASONS = new Set(['no_match', 'id_not_found', 'ambiguous_id'])

const RETIRED_THOUGHT_FIELDS = new Set(['is_profile'])

function assertHygiene(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      assertHygiene(value, `${path}[${index}]`)
    })
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  if (keys.length === 2 && keys[0] === 'id' && keys[1] === 'name') {
    throw new Error(`tag object {id,name} at ${path} — tags must be plain strings`)
  }
  for (const [key, value] of Object.entries(obj)) {
    if (RETIRED_THOUGHT_FIELDS.has(key)) {
      throw new Error(`retired thought field '${key}' leaked at ${path}`)
    }
    if (BOOLEAN_FIELDS.has(key) && value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${path}.${key} must be a boolean, got ${typeof value} (${String(value)})`)
    }
    if (key === 'tags' && Array.isArray(value)) {
      for (const tag of value) {
        if (typeof tag !== 'string')
          throw new Error(`${path}.tags must hold strings, got ${JSON.stringify(tag)}`)
      }
    }
    assertHygiene(value, `${path}.${key}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertEnvelope(
  c: ActionCase,
  result: unknown
): { payload: Record<string, unknown>; meta: Record<string, unknown> } {
  const { payload, isError, text, rawContent } = readResult(result)
  if (isError) throw new Error(`${c.tool} ${c.action} answered isError: ${text}`)
  if (!isPlainObject(payload))
    throw new Error(`${c.tool} ${c.action} payload is not an object: ${text}`)

  if (!c.noMirror && JSON.stringify(rawContent) !== JSON.stringify(payload)) {
    throw new Error(`${c.tool} ${c.action}: content[] and structuredContent.result disagree`)
  }

  const keys = Object.keys(payload).sort()
  const expected =
    c.slot === 'graph' ? ['edges', 'items', 'meta'] : [c.slot === 'item' ? 'item' : 'items', 'meta']
  if (JSON.stringify(keys) !== JSON.stringify(expected.sort())) {
    throw new Error(
      `${c.tool} ${c.action}: expected exactly ${expected.join('+')}, got ${keys.join('+')}`
    )
  }
  for (const legacy of LEGACY_KEYS) {
    if (c.slot === 'graph' && legacy === 'edges') continue
    if (payload[legacy] !== undefined)
      throw new Error(`${c.tool} ${c.action}: legacy key '${legacy}' leaked`)
  }
  if (c.slot === 'item') {
    if (!('item' in payload)) throw new Error(`${c.tool} ${c.action}: missing item`)
  } else if (!Array.isArray(payload.items)) {
    throw new Error(`${c.tool} ${c.action}: items is not an array`)
  }
  if (c.slot === 'graph' && !Array.isArray(payload.edges)) {
    throw new Error(`${c.tool} ${c.action}: graph edges is not an array`)
  }

  const meta = payload.meta
  if (!isPlainObject(meta)) throw new Error(`${c.tool} ${c.action}: meta is not an object`)
  for (const key of Object.keys(meta)) {
    if (!META_KEYS.has(key)) throw new Error(`${c.tool} ${c.action}: unexpected meta key '${key}'`)
  }
  for (const required of ['action', 'scope', 'counts', 'degraded', 'warnings']) {
    if (!(required in meta)) throw new Error(`${c.tool} ${c.action}: meta.${required} is missing`)
  }
  const expectedAction = c.metaAction ?? c.action
  if (meta.action !== expectedAction) {
    throw new Error(
      `${c.tool} ${c.action}: meta.action is '${String(meta.action)}', expected '${expectedAction}'`
    )
  }

  const counts = meta.counts
  if (!isPlainObject(counts)) throw new Error(`${c.tool} ${c.action}: meta.counts is not an object`)
  for (const key of ['total', 'returned', 'filtered_out']) {
    if (typeof counts[key] !== 'number' || !Number.isFinite(counts[key] as number)) {
      throw new Error(`${c.tool} ${c.action}: meta.counts.${key} is not a number`)
    }
    if ((counts[key] as number) < 0)
      throw new Error(`${c.tool} ${c.action}: meta.counts.${key} is negative`)
  }
  const slotSize =
    c.slot === 'item' ? (payload.item === null ? 0 : 1) : (payload.items as unknown[]).length
  if (counts.returned !== slotSize) {
    throw new Error(
      `${c.tool} ${c.action}: meta.counts.returned=${String(counts.returned)} but the slot holds ${slotSize}`
    )
  }
  if (c.slot === 'graph' && counts.edges !== (payload.edges as unknown[]).length) {
    throw new Error(`${c.tool} ${c.action}: meta.counts.edges does not match edges.length`)
  }

  if (meta.scope !== null) {
    const scope = meta.scope
    if (!isPlainObject(scope))
      throw new Error(`${c.tool} ${c.action}: meta.scope is neither null nor an object`)
    for (const key of ['project', 'project_name', 'global']) {
      if (!(key in scope)) throw new Error(`${c.tool} ${c.action}: meta.scope.${key} is missing`)
    }
    if (scope.project !== null && typeof scope.project !== 'string')
      throw new Error(`${c.tool} ${c.action}: meta.scope.project is not a string|null`)
    if (scope.project_name !== null && typeof scope.project_name !== 'string')
      throw new Error(`${c.tool} ${c.action}: meta.scope.project_name is not a string|null`)
    if (typeof scope.global !== 'boolean')
      throw new Error(`${c.tool} ${c.action}: meta.scope.global is not a boolean`)
  }
  if (typeof meta.degraded !== 'boolean')
    throw new Error(`${c.tool} ${c.action}: meta.degraded is not a boolean`)
  if (!Array.isArray(meta.warnings) || meta.warnings.some(w => typeof w !== 'string')) {
    throw new Error(`${c.tool} ${c.action}: meta.warnings is not a string[]`)
  }
  if (meta.reason !== undefined && !REASONS.has(String(meta.reason))) {
    throw new Error(
      `${c.tool} ${c.action}: meta.reason '${String(meta.reason)}' is not one of ${[...REASONS].join(', ')}`
    )
  }
  if (meta.preview !== undefined) {
    const preview = meta.preview
    if (!isPlainObject(preview))
      throw new Error(`${c.tool} ${c.action}: meta.preview is not an object`)
    if (preview.destructive !== true)
      throw new Error(`${c.tool} ${c.action}: meta.preview.destructive must be true`)
    if (preview.token !== null && typeof preview.token !== 'string')
      throw new Error(`${c.tool} ${c.action}: meta.preview.token is not string|null`)
  }
  if (c.preview === true && meta.preview === undefined) {
    throw new Error(`${c.tool} ${c.action}: preview answer carries no meta.preview`)
  }
  assertNoItemPreviewToken(payload, `${c.tool}.${c.action}`)

  assertHygiene(payload, `${c.tool}.${c.action}`)
  return { payload, meta }
}

function assertNoItemPreviewToken(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      assertNoItemPreviewToken(value, `${path}[${index}]`)
    })
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'preview_token') {
      throw new Error(`preview_token leaked at ${path}.${key} — the token belongs in meta.preview`)
    }
    assertNoItemPreviewToken(value, `${path}.${key}`)
  }
}

async function advertisedTools(): Promise<
  Array<{ name: string; description?: string; inputSchema?: unknown }>
> {
  const { tools } = await client.listTools()
  return tools as Array<{ name: string; description?: string; inputSchema?: unknown }>
}

function schemaProps(tool: { inputSchema?: unknown }): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined
  return schema?.properties ?? {}
}

beforeEach(() => {
  createTestDb()
  seedFixture()
})
afterEach(() => {
  closeDb()
})
beforeAll(async () => {
  client = await setupClient()
})

for (const c of CASES) {
  const runner = c.knownDefect === undefined ? test : test.failing
  const label = `${c.tool} action=${c.action} answers the shared envelope`
  runner(label, async () => {
    const args = { action: c.action, ...c.args(fx), ...(c.cwd === true ? { cwd: CWD } : {}) }
    assertEnvelope(c, await client.callTool({ name: c.tool, arguments: args } as never))
  })
}

describe('action table completeness', () => {
  test('every action of every action tool is in the table, and nothing extra', async () => {
    const tools = await advertisedTools()
    const actionTools = tools.filter(t => schemaProps(t).action !== undefined)
    expect(actionTools.map(t => t.name).sort()).toEqual(ACTION_TOOLS)

    for (const tool of actionTools) {
      const advertised = ((schemaProps(tool).action as { enum?: string[] }).enum ?? [])
        .slice()
        .sort()
      const covered = CASES.filter(c => c.tool === tool.name)
        .map(c => c.action)
        .sort()
      expect(covered).toEqual(advertised)
    }
  })

  test('the graph exception is documented on memory_crystallize', async () => {
    const tool = (await advertisedTools()).find(t => t.name === 'memory_crystallize')
    expect(tool?.description).toContain('exception')
    expect(tool?.description).toContain('edges')
  })
})

const NO_CWD_WARNING = 'no cwd — the answer spans every project'

const SLOTS_OVERRIDES_WARNING =
  'no project scope — the project-scoped slot overrides were not applied (pass cwd to read them)'

interface CwdContractCase {
  tool: string
  action: string
  args: (f: Fixture) => Record<string, unknown>
  warns: boolean
}

const CWD_OPTIONAL: CwdContractCase[] = [
  {
    tool: 'memory_recall',
    action: 'search',
    args: () => ({ query: 'conformance source alpha' }),
    warns: true
  },
  {
    tool: 'memory_recall',
    action: 'clusters',
    args: () => ({ query: 'conformance cluster' }),
    warns: true
  },
  { tool: 'memory_recall', action: 'list', args: () => ({}), warns: true },
  { tool: 'memory_status', action: 'slots', args: () => ({}), warns: true },
  { tool: 'memory_status', action: 'frontier', args: () => ({}), warns: true },
  {
    tool: 'memory_reflect',
    action: 'reflect',
    args: () => ({ summary: 'conformance cwd-less reflect' }),
    warns: false
  },
  { tool: 'memory_reflect', action: 'timeline', args: () => ({}), warns: true }
]

async function cwdContractMeta(c: CwdContractCase, cwd?: string): Promise<Record<string, unknown>> {
  const { payload, isError, text } = readResult(
    await client.callTool({
      name: c.tool,
      arguments: { action: c.action, ...c.args(fx), ...(cwd === undefined ? {} : { cwd }) }
    } as never)
  )
  if (isError) throw new Error(`${c.tool} ${c.action} answered isError: ${text}`)
  if (!isPlainObject(payload))
    throw new Error(`${c.tool} ${c.action}: payload is not an object: ${text}`)
  const meta = payload.meta
  if (!isPlainObject(meta)) throw new Error(`${c.tool} ${c.action}: meta is not an object`)
  return meta
}

describe('cwd is optional: a call without it answers with no scope', () => {
  for (const c of CWD_OPTIONAL) {
    test(`${c.tool} action=${c.action} answers without cwd and reports scope null`, async () => {
      const meta = await cwdContractMeta(c)
      expect(meta.scope).toBeNull()
      if (c.warns) {
        expect(meta.warnings).toContain(NO_CWD_WARNING)
      } else {
        expect(meta.warnings).toEqual([])
      }
    })

    test(`${c.tool} action=${c.action} with a registered cwd scopes the answer`, async () => {
      const meta = await cwdContractMeta(c, CWD)
      expect(meta.scope).toEqual({
        project: PROJECT,
        project_name: 'Conformance',
        global: false
      })
      expect(meta.warnings).not.toContain(NO_CWD_WARNING)
    })
  }

  test('slots without cwd also notes that the project-scoped overrides were not applied', async () => {
    const meta = await cwdContractMeta({
      tool: 'memory_status',
      action: 'slots',
      args: () => ({}),
      warns: true
    })
    expect(meta.warnings).toEqual([NO_CWD_WARNING, SLOTS_OVERRIDES_WARNING])
  })
})

const UNREGISTERED_CWD = '/tmp/opencode/unregistered-project'
const SPANS_EVERY_PROJECT_CLAIM = 'the answer spans every project'

describe('memory_reflect action=reflect without cwd writes to the default project', () => {
  test('decisions and pending land there with scope null and no warning', async () => {
    const decision = 'cwd-less reflect decision marker'
    const pending = 'cwd-less reflect pending marker'
    const { payload, isError } = readResult(
      await client.callTool({
        name: 'memory_reflect',
        arguments: {
          action: 'reflect',
          summary: 'cwd-less reflect summary',
          decisions: [decision],
          pending: [pending]
        }
      } as never)
    )
    expect(isError).toBe(false)
    const body = payload as {
      item: { decisions_created: number; pending_created: number; summary_appended: boolean }
      meta: Record<string, unknown>
    }
    expect(body.meta.scope).toBeNull()
    expect(body.meta.warnings).toEqual([])
    expect(body.item.decisions_created).toBe(1)
    expect(body.item.pending_created).toBe(1)

    const db = getDb()
    const defaultId = resolveDefaultProjectId(db)
    const rows = db
      .prepare('SELECT content, project_id FROM thoughts WHERE content IN (?, ?)')
      .all(decision, pending) as Array<{ content: string; project_id: string }>
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.project_id).toBe(defaultId)
  })

  test('it lands where a cwd-less memory_store create lands', async () => {
    const decision = 'cwd-less equivalence decision'
    const reflected = readResult(
      await client.callTool({
        name: 'memory_reflect',
        arguments: { action: 'reflect', decisions: [decision] }
      } as never)
    )
    expect(reflected.isError).toBe(false)

    const created = readResult(
      await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: 'cwd-less equivalence store row' }
      } as never)
    )
    expect(created.isError).toBe(false)
    const storedId = (created.payload as { item: { id: string } }).item.id

    const db = getDb()
    const projectOf = (content: string) =>
      (
        db.prepare('SELECT project_id FROM thoughts WHERE content = ?').get(content) as {
          project_id: string
        }
      ).project_id
    const storedProject = (
      db.prepare('SELECT project_id FROM thoughts WHERE id = ?').get(storedId) as {
        project_id: string
      }
    ).project_id
    expect(projectOf(decision)).toBe(storedProject)
    expect(storedProject).toBe(resolveDefaultProjectId(db))
  })
})

const OTHER_PROJECT = 'proj-conformance-b'
const OTHER_CONTENT = 'crossscoped alpha row in project B'
const SCOPED_CONTENT = 'crossscoped alpha row in project A'

function seedCrossProjectRows(): { scopedId: string; otherId: string } {
  return {
    scopedId: seedThought({ content: SCOPED_CONTENT, project_id: PROJECT }),
    otherId: seedThought({ content: OTHER_CONTENT, project_id: OTHER_PROJECT })
  }
}

function answerIds(payload: unknown): string[] {
  const items = (payload as { items: Array<{ thought?: { id?: string }; id?: string }> }).items
  return items.map(row => row.thought?.id ?? row.id ?? '')
}

async function crossProjectRows(
  tool: string,
  action: string,
  args: Record<string, unknown>,
  cwd?: string
): Promise<string[]> {
  const { payload, isError, text } = readResult(
    await client.callTool({
      name: tool,
      arguments: { action, ...args, ...(cwd === undefined ? {} : { cwd }) }
    } as never)
  )
  if (isError) throw new Error(`${tool} ${action} answered isError: ${text}`)
  return answerIds(payload)
}

describe('a cwd-less search spans every project', () => {
  test('both projects’ rows are visible without cwd, and only project A’s with one', async () => {
    const { scopedId, otherId } = seedCrossProjectRows()

    const all = await crossProjectRows('memory_recall', 'search', { query: 'crossscoped' })
    expect(all.sort()).toEqual([scopedId, otherId].sort())

    const scoped = await crossProjectRows('memory_recall', 'search', { query: 'crossscoped' }, CWD)
    expect(scoped).toEqual([scopedId])
  })
})

describe('a cwd-less list spans every project', () => {
  test('both projects’ rows are listed without cwd, and only project A’s with one', async () => {
    const { scopedId, otherId } = seedCrossProjectRows()

    const all = await crossProjectRows('memory_recall', 'list', {})
    expect(all).toEqual(expect.arrayContaining([scopedId, otherId]))

    const scoped = await crossProjectRows('memory_recall', 'list', {}, CWD)
    expect(scoped).toContain(scopedId)
    expect(scoped).not.toContain(otherId)
  })
})

describe('a cwd-less timeline spans every project', () => {
  test('both projects’ rows are listed without cwd, and only project A’s with one', async () => {
    const { scopedId, otherId } = seedCrossProjectRows()

    const all = await crossProjectRows('memory_reflect', 'timeline', {})
    expect(all).toEqual(expect.arrayContaining([scopedId, otherId]))

    const scoped = await crossProjectRows('memory_reflect', 'timeline', {}, CWD)
    expect(scoped).toContain(scopedId)
    expect(scoped).not.toContain(otherId)
  })
})

describe('memory_manage action=resolve still requires cwd', () => {
  test('a cwd-less resolve is rejected with the actionable message', async () => {
    const { isError, text } = readResult(
      await client.callTool({ name: 'memory_manage', arguments: { action: 'resolve' } } as never)
    )
    expect(isError).toBe(true)
    expect(text).toContain('cwd is required for resolve action')
  })
})

describe('fields selection drops scoring metadata', () => {
  test('search with fields=[id,content] returns exactly those columns plus the envelope', async () => {
    const { payload, isError } = readResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: {
          action: 'search',
          query: 'conformance source alpha',
          cwd: CWD,
          compact: false,
          fields: ['id', 'content']
        }
      } as never)
    )
    expect(isError).toBe(false)
    const body = payload as { items: Array<Record<string, unknown>>; meta: Record<string, unknown> }
    expect(body.items.length).toBeGreaterThan(0)
    for (const item of body.items) {
      expect(Object.keys(item)).toEqual(['thought'])
      const thought = item.thought as Record<string, unknown>
      expect(Object.keys(thought).sort()).toEqual(['content', 'id'])
    }
    expect(body.items.some(item => (item.thought as { id: string }).id === fx.source)).toBe(true)
    expect(body.meta.action).toBe('search')
  })

  test('the same search without fields keeps the opt-in scoring block', async () => {
    const { payload } = readResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: 'conformance source alpha', cwd: CWD, compact: false }
      } as never)
    )
    const item = (payload as { items: Array<Record<string, unknown>> }).items.find(
      i => (i.thought as { id?: string }).id === fx.source
    )
    expect(item).toBeDefined()
    expect(item?.scores).toBeDefined()
    expect(item?.match_source).toBeDefined()
  })
})

describe('empty and ambiguous search pass a reason through meta', () => {
  test('a query that matches nothing reports reason=no_match', async () => {
    const { payload, isError } = readResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: 'zzzznomatchtokenxyz', cwd: CWD }
      } as never)
    )
    expect(isError).toBe(false)
    const body = payload as { items: unknown[]; meta: Record<string, unknown> }
    expect(body.items).toEqual([])
    expect(body.meta.reason).toBe('no_match')
    expect((body.meta.counts as { total: number }).total).toBe(0)
  })

  test('an ambiguous id prefix reports reason=ambiguous_id', async () => {
    seedThought({
      id: 'abcdef01-0000-7000-8000-000000000001',
      content: 'conformance prefix one',
      project_id: PROJECT
    })
    seedThought({
      id: 'abcdef01-0000-7000-8000-000000000002',
      content: 'conformance prefix two',
      project_id: PROJECT
    })
    const { payload, isError } = readResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: 'abcdef0100007', cwd: CWD }
      } as never)
    )
    expect(isError).toBe(false)
    const body = payload as {
      items: Array<{ thought: { id: string } }>
      meta: Record<string, unknown>
    }
    expect(body.items.map(i => i.thought.id).sort()).toEqual([
      'abcdef01-0000-7000-8000-000000000001',
      'abcdef01-0000-7000-8000-000000000002'
    ])
    expect(body.meta.reason).toBe('ambiguous_id')
  })
})

const UNKNOWN_CWD_WARNING = `cwd "${UNREGISTERED_CWD}" matches no known project — the answer spans every project (check it with memory_manage action=resolve)`

describe('memory_status action=slots keys its overrides note on the resolved project', () => {
  const slotsMeta = (cwd?: string) =>
    cwdContractMeta({ tool: 'memory_status', action: 'slots', args: () => ({}), warns: true }, cwd)

  test('a registered cwd resolves the project and raises no note', async () => {
    const meta = await slotsMeta(CWD)
    expect(meta.scope).toEqual({ project: PROJECT, project_name: 'Conformance', global: false })
    expect(meta.warnings).toEqual([])
  })

  test('an unregistered cwd notes the unknown path and the skipped overrides', async () => {
    const meta = await slotsMeta(UNREGISTERED_CWD)
    expect(meta.scope).toEqual({ project: null, project_name: null, global: true })
    expect(meta.warnings).toEqual([UNKNOWN_CWD_WARNING, SLOTS_OVERRIDES_WARNING])
  })

  test('an omitted cwd notes the missing scope and the skipped overrides', async () => {
    const meta = await slotsMeta()
    expect(meta.scope).toBeNull()
    expect(meta.warnings).toEqual([NO_CWD_WARNING, SLOTS_OVERRIDES_WARNING])
  })
})

describe('a write with an unregistered cwd raises no widening note and keeps its real destination', () => {
  test('create lands in the default project with scope.global and no warning', async () => {
    const content = 'unregistered cwd create row'
    const { payload, isError } = readResult(
      await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content, cwd: UNREGISTERED_CWD }
      } as never)
    )
    expect(isError).toBe(false)

    const db = getDb()
    const destination = resolveDefaultProjectId(db)
    const body = payload as { item: { project: string }; meta: Record<string, unknown> }
    const warnings = body.meta.warnings as string[]
    expect(body.meta.scope).toEqual({ project: null, project_name: null, global: true })
    expect(warnings).toEqual([])
    expect(warnings.join('\n')).not.toContain(SPANS_EVERY_PROJECT_CLAIM)

    const row = db.prepare('SELECT project_id FROM thoughts WHERE content = ?').get(content) as {
      project_id: string
    }
    expect(row.project_id).toBe(destination)
    const destinationName = (
      db.prepare('SELECT name FROM projects WHERE id = ?').get(destination) as { name: string }
    ).name
    for (const warning of warnings) expect(warning).toContain(destinationName)
  })

  test('update keeps the row’s own project with scope.global and no warning', async () => {
    const { payload, isError } = readResult(
      await client.callTool({
        name: 'memory_store',
        arguments: {
          action: 'update',
          thought_id: fx.source,
          content: 'conformance source alpha revised',
          cwd: UNREGISTERED_CWD
        }
      } as never)
    )
    expect(isError).toBe(false)

    const body = payload as { item: { project: string }; meta: Record<string, unknown> }
    const warnings = body.meta.warnings as string[]
    expect(body.meta.scope).toEqual({ project: null, project_name: null, global: true })
    expect(warnings).toEqual([])
    expect(warnings.join('\n')).not.toContain(SPANS_EVERY_PROJECT_CLAIM)
    expect(body.item.project).toBe('Conformance')
    for (const warning of warnings) expect(warning).toContain('Conformance')
  })
})

describe('a whitespace-only cwd reads exactly like an omitted one', () => {
  test('memory_recall list answers scope null, the widening note and the same meta', async () => {
    const c: CwdContractCase = {
      tool: 'memory_recall',
      action: 'list',
      args: () => ({}),
      warns: true
    }
    const omitted = await cwdContractMeta(c)
    const blank = await cwdContractMeta(c, '   ')
    expect(blank.scope).toBeNull()
    expect(blank.warnings).toEqual([NO_CWD_WARNING])
    expect(blank).toEqual(omitted)
  })
})

interface CwdAcceptedCase {
  tool: string
  action: string
  args: (f: Fixture) => Record<string, unknown>
}

const CWD_ACCEPTED: CwdAcceptedCase[] = [
  {
    tool: 'memory_recall',
    action: 'get',
    args: f => ({ thought_id: f.source })
  },
  {
    tool: 'memory_recall',
    action: 'chain',
    args: f => ({ thought_id: f.source })
  },
  {
    tool: 'memory_store',
    action: 'link',
    args: f => ({ source_id: f.source, target_id: f.target })
  },
  {
    tool: 'memory_supersede',
    action: 'archive',
    args: f => ({ thought_id: f.target })
  },
  {
    tool: 'memory_status',
    action: 'health',
    args: () => ({})
  },
  {
    tool: 'memory_status',
    action: 'config',
    args: () => ({})
  },
  {
    tool: 'memory_primers',
    action: 'list',
    args: () => ({})
  },
  {
    tool: 'memory_crystallize',
    action: 'auto_cluster',
    args: () => ({})
  }
]

const CWD_REJECTED_PHRASES = ['IGNORED for', 'takes no cwd', 'take no `cwd`']

// The cwd descriptions that name actions the argument does not scope. Pinned per
// tool because the words, not the tool-level prose, are the client-visible contract.
const CWD_IGNORE_CLAUSE: Record<string, { clause: string; scopes: string }> = {
  memory_store: {
    clause: 'ACCEPTED AND IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".',
    scopes: 'always pass for "create"/"update"'
  },
  memory_recall: {
    clause: 'ACCEPTED AND IGNORED for get/chain.',
    scopes: 'OPTIONAL for search/clusters/list/context'
  },
  memory_supersede: {
    clause: 'ACCEPTED AND IGNORED for "archive" and "archive_batch".',
    scopes: 'OPTIONAL for "merge"'
  },
  memory_status: {
    clause: 'ACCEPTED AND IGNORED for "config", "health".',
    scopes: 'OPTIONAL for "slots" and "frontier"'
  },
  memory_crystallize: {
    clause: 'ACCEPTED AND IGNORED for "auto_cluster".',
    scopes: 'OPTIONAL for "graph" and "cluster"'
  },
  memory_manage: {
    clause: 'ACCEPTED AND IGNORED for all other actions.',
    scopes: 'REQUIRED for "resolve"'
  }
}

function cwdDescription(tool: { inputSchema?: unknown }): string {
  const cwd = schemaProps(tool).cwd as { description?: unknown } | undefined
  return typeof cwd?.description === 'string' ? cwd.description.replace(/\s+/g, ' ').trim() : ''
}

function acceptedIgnoreClause(description: string): string {
  const start = description.indexOf('ACCEPTED AND IGNORED')
  if (start < 0) return ''
  const end = description.indexOf('.', start)
  return description.slice(start, end < 0 ? undefined : end + 1)
}

describe('cwd is accepted on every action, including the ones it does not scope', () => {
  for (const c of CWD_ACCEPTED) {
    test(`${c.tool} action=${c.action} answers with a cwd it ignores`, async () => {
      const { isError, text } = readResult(
        await client.callTool({
          name: c.tool,
          arguments: { action: c.action, ...c.args(fx), cwd: CWD }
        } as never)
      )
      expect(text).not.toContain('not applicable')
      expect({ action: c.action, isError }).toEqual({ action: c.action, isError: false })
    })
  }

  test('the guard table covers exactly the cwd descriptions that claim an ignored action', async () => {
    const claiming = (await advertisedTools())
      .filter(tool => acceptedIgnoreClause(cwdDescription(tool)) !== '')
      .map(tool => tool.name)
      .sort()
    expect(claiming).toEqual(Object.keys(CWD_IGNORE_CLAUSE).sort())
  })

  for (const [tool, contract] of Object.entries(CWD_IGNORE_CLAUSE)) {
    test(`${tool} advertises cwd as accepted and ignored for the actions it does not scope`, async () => {
      const advertised = (await advertisedTools()).find(t => t.name === tool)
      if (!advertised) throw new Error(`${tool} is not advertised`)
      const description = cwdDescription(advertised)
      expect(acceptedIgnoreClause(description)).toBe(contract.clause)
      expect(description.split('ACCEPTED AND IGNORED').join('')).not.toContain('IGNORED for')
      expect(description).toContain(contract.scopes)
    })
  }

  test('no tool-level description claims an action rejects cwd', async () => {
    for (const tool of await advertisedTools()) {
      for (const phrase of CWD_REJECTED_PHRASES) {
        expect({
          tool: tool.name,
          phrase,
          claims: (tool.description ?? '').includes(phrase)
        }).toEqual({ tool: tool.name, phrase, claims: false })
      }
    }
  })
})

describe('every action of every tool accepts cwd', () => {
  for (const c of CASES) {
    test(`${c.tool} action=${c.action} answers the same call with cwd attached`, async () => {
      const { isError, text } = readResult(
        await client.callTool({
          name: c.tool,
          arguments: { action: c.action, ...c.args(fx), cwd: CWD }
        } as never)
      )
      if (isError) throw new Error(`${c.tool} ${c.action} refused cwd: ${text}`)
    })
  }
})

const REFUSAL_SWEEP: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'memory_crystallize', args: { action: 'not_an_action' } },
  { tool: 'memory_manage', args: { action: 'not_an_action' } },
  { tool: 'memory_primers', args: { action: 'not_an_action' } },
  { tool: 'memory_recall', args: { action: 'not_an_action' } },
  { tool: 'memory_reflect', args: { action: 'not_an_action' } },
  { tool: 'memory_status', args: { action: 'not_an_action' } },
  { tool: 'memory_store', args: { action: 'not_an_action' } },
  { tool: 'memory_supersede', args: { action: 'not_an_action' } },
  { tool: 'retention_review', args: { action: 'not_an_action' } }
]

function refusal(result: unknown): { message: string; text: string } {
  const { payload, isError, text } = readResult(result)
  if (!isError) throw new Error(`expected a refusal, got a success: ${text}`)
  const error = (payload as { error?: { message?: unknown } } | undefined)?.error
  if (!isPlainObject(error) || typeof error.message !== 'string') {
    throw new Error(`refusal carried no structuredContent.result.error: ${text}`)
  }
  return { message: error.message, text }
}

function actionEnum(tool: { inputSchema?: unknown }): string[] {
  const action = schemaProps(tool).action as { enum?: unknown } | undefined
  if (!Array.isArray(action?.enum)) throw new Error('the tool advertises no action enum')
  return action.enum.map(String)
}

function unknownActionRefusal(tool: string, enumValues: string[]): string {
  const quoted = enumValues.map(value => `"${value}"`).join('|')
  return `Input validation error: Invalid arguments for tool ${tool}: action: Invalid option: expected one of ${quoted}`
}

describe('every registered tool refuses a bad argument in the structured error envelope', () => {
  test('the sweep table covers every tool that advertises an action', async () => {
    const actionTools = (await advertisedTools()).filter(t => schemaProps(t).action !== undefined)
    expect(actionTools.map(t => t.name).sort()).toEqual(REFUSAL_SWEEP.map(c => c.tool).sort())
  })

  for (const c of REFUSAL_SWEEP) {
    test(`${c.tool} answers an unknown action with structuredContent.result.error`, async () => {
      const { message, text } = refusal(
        await client.callTool({ name: c.tool, arguments: c.args } as never)
      )
      const tool = (await advertisedTools()).find(t => t.name === c.tool)
      if (!tool) throw new Error(`${c.tool} is not advertised`)
      expect(message).toBe(unknownActionRefusal(c.tool, actionEnum(tool)))
      expect(text).toBe(message)
    })
  }

  test('memory_guide advertises no arguments, so there is no argument it could refuse', async () => {
    const tool = (await advertisedTools()).find(t => t.name === 'memory_guide')
    expect(Object.keys(schemaProps(tool ?? {}))).toEqual([])
    const { isError, text } = readResult(
      await client.callTool({
        name: 'memory_guide',
        arguments: { action: 'not_an_action' }
      } as never)
    )
    expect({ isError, refused: text.includes('Invalid arguments') }).toEqual({
      isError: false,
      refused: false
    })
  })
})

const PINNED_REFUSALS = [
  {
    label: 'an unknown action',
    tool: 'memory_recall',
    args: { action: 'nope' },
    message:
      'Input validation error: Invalid arguments for tool memory_recall: action: Invalid option: expected one of "search"|"get"|"context"|"chain"|"clusters"|"list"'
  },
  {
    label: 'a retired tombstone',
    tool: 'memory_recall',
    args: { action: 'search', query: 'conformance source alpha', top_k: 1 },
    message:
      'Input validation error: Invalid arguments for tool memory_recall: top_k: top_k was removed; use limit'
  },
  {
    label: 'a wrong-typed argument',
    tool: 'memory_recall',
    args: { action: 'search', query: 'conformance source alpha', limit: 'many' },
    message:
      'Input validation error: Invalid arguments for tool memory_recall: limit: Invalid input: expected number, received NaN'
  },
  {
    label: 'a missing required argument',
    tool: 'memory_manage',
    args: { action: 'resolve' },
    message: 'cwd is required for resolve action'
  }
]

describe('refusal wording is byte-identical to the pre-wrapper answer', () => {
  for (const c of PINNED_REFUSALS) {
    test(`${c.label} reads exactly as it did before the wrapper`, async () => {
      const { message, text } = refusal(
        await client.callTool({ name: c.tool, arguments: c.args } as never)
      )
      expect(message).toBe(c.message)
      expect(text).toBe(c.message)
    })
  }
})

function structuredError(result: unknown): { message: string; statusCode?: number } {
  const { payload, isError, text } = readResult(result)
  if (!isError) throw new Error(`expected a failure, got a success: ${text}`)
  const error = (payload as { error?: { message?: unknown; statusCode?: unknown } } | undefined)
    ?.error
  if (!isPlainObject(error) || typeof error.message !== 'string') {
    throw new Error(`failure carried no structuredContent.result.error: ${text}`)
  }
  return error as { message: string; statusCode?: number }
}

describe('every failure answers the structured error envelope', () => {
  test('a schema failure is an error result, not a text-only SDK rejection', async () => {
    const error = structuredError(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: 'conformance source alpha', limit: 'many' }
      } as never)
    )
    expect(error.message).not.toBe('')
  })

  test('a per-action input failure carries its message', async () => {
    const error = structuredError(
      await client.callTool({ name: 'memory_manage', arguments: { action: 'resolve' } } as never)
    )
    expect(error.message).toContain('cwd is required for resolve action')
  })

  test('a domain failure carries its status code', async () => {
    const error = structuredError(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'get', thought_id: 'no-such-thought' }
      } as never)
    )
    expect(error.statusCode).toBe(404)
  })
})

describe('a preview token lives only in meta.preview', () => {
  const PREVIEW_TOKEN_ACTIONS: CwdAcceptedCase[] = [
    { tool: 'memory_store', action: 'unlink', args: f => ({ edge_id: f.edgeId }) },
    {
      tool: 'memory_store',
      action: 'retype',
      args: f => ({ edge_id: f.edgeId, new_type: 'related' })
    },
    { tool: 'memory_supersede', action: 'archive', args: f => ({ thought_id: f.target }) },
    {
      tool: 'memory_supersede',
      action: 'merge',
      args: f => ({ source_id: f.target, target_id: f.source })
    },
    { tool: 'memory_manage', action: 'delete', args: () => ({ project_id: PROJECT }) },
    { tool: 'retention_review', action: 'delete', args: f => ({ thought_id: f.retention }) }
  ]

  for (const c of PREVIEW_TOKEN_ACTIONS) {
    test(`${c.tool} action=${c.action} keeps the token out of item`, async () => {
      const { payload, isError, text } = readResult(
        await client.callTool({
          name: c.tool,
          arguments: { action: c.action, ...c.args(fx) }
        } as never)
      )
      if (isError) throw new Error(`${c.tool} ${c.action} answered isError: ${text}`)
      const body = payload as { item?: Record<string, unknown>; meta: Record<string, unknown> }
      expect(JSON.stringify(body)).not.toContain('preview_token')
      expect(body.item?.preview_token).toBeUndefined()
      const preview = body.meta.preview as { token?: unknown } | undefined
      expect(typeof preview?.token).toBe('string')
    })
  }

  test('memory_primers delete keeps the token in meta.preview only', async () => {
    const { promoteThoughtToPrimer } = await import('../../db/primers')
    const primer = promoteThoughtToPrimer(getDb(), fx.source, 5)
    if (!primer) throw new Error('fixture primer was not created')

    const { payload, isError, text } = readResult(
      await client.callTool({
        name: 'memory_primers',
        arguments: { action: 'delete', primer_id: primer.id }
      } as never)
    )
    if (isError) throw new Error(`memory_primers delete answered isError: ${text}`)
    const body = payload as { item?: Record<string, unknown>; meta: Record<string, unknown> }
    expect(JSON.stringify(body)).not.toContain('preview_token')
    const preview = body.meta.preview as { token?: unknown } | undefined
    expect(typeof preview?.token).toBe('string')
  })
})

const TOKENLESS_PREVIEWS = new Set(['memory_store.unlink_batch', 'retention_review.compact'])

describe('no action envelope carries preview_token outside meta.preview', () => {
  for (const c of CASES) {
    test(`${c.tool} action=${c.action} keeps every token in meta.preview`, async () => {
      const { payload, isError, text } = readResult(
        await client.callTool({
          name: c.tool,
          arguments: { action: c.action, ...c.args(fx), cwd: CWD }
        } as never)
      )
      if (isError) throw new Error(`${c.tool} ${c.action} answered isError: ${text}`)
      assertNoItemPreviewToken(payload, `${c.tool}.${c.action}`)
      if (c.preview !== true) return

      const meta = (payload as { meta?: Record<string, unknown> }).meta
      const preview = meta?.preview
      if (!isPlainObject(preview))
        throw new Error(`${c.tool} ${c.action}: preview answer carries no meta.preview`)
      const label = `${c.tool}.${c.action}`
      if (TOKENLESS_PREVIEWS.has(label)) {
        expect({ label, token: preview.token }).toEqual({ label, token: null })
      } else {
        expect({ label, token: typeof preview.token }).toEqual({ label, token: 'string' })
      }
    })
  }
})
