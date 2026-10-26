/**
 * MCP envelope conformance suite (task #2182).
 *
 * One table walks every action of every action-multiplexed MCP tool and pins the
 * shared contract introduced by tasks #2179 (read side) / #2181 (write side):
 *
 * - exactly one payload slot per answer — `item`, `items`, or the documented
 *   `graph` exception (`items` + `edges`);
 * - `meta` always carries `action`, `scope`, `counts`, `degraded`, `warnings`
 *   (plus the optional `reason` / `preview`);
 * - no legacy top-level key leaks (`thoughts`, `nodes`, `best_match`, bare
 *   arrays, `{ text }` outside `item`);
 * - output hygiene: tag names are plain strings and 0/1 flag columns are
 *   booleans everywhere in the payload.
 *
 * Two further describes pin the hard `cwd` contract and the shaping guarantees
 * (`fields` selection, `reason` passthrough).
 *
 * The table is checked against the advertised `action` enum of every tool, so a
 * newly added action fails this suite until it is covered here — the surface
 * cannot drift back to a per-action answer shape.
 *
 * Known defects found by this suite are pinned with `test.failing` (a fix flips
 * them red, so the pin is removed deliberately) and were reported on the task.
 * The two defects the suite originally pinned were fixed by task #2185 and their
 * cases are ordinary passing tests now: `memory_primers` action=delete answers
 * `{ item, meta }`, and `memory_reflect` action=timeline shapes its rows with the
 * shared read-surface hygiene.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb, closeDb } from '../../db'
import { getEdgePairBetween } from '../../db/edges'
import { getThoughtRow } from '../../db/thoughts'
import { insertProposal } from '../../db/placement-proposals'
import { computeFingerprint } from '../../services/placement-proposals.service'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// Search/cluster/enqueue run the embedding legs; the queue shares one mocked
// module with the other MCP contract tests.
mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: (texts: string[]) => texts.map(() => new Float32Array(384)),
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

/** The `{ result }` payload the SDK validated, plus its `content` mirror. */
function readResult(result: unknown): { payload: unknown; isError: boolean; text: string; rawContent: unknown } {
  const r = result as ToolResult
  const text = r.content?.[0]?.text ?? ''
  let parsedContent: unknown = text
  try {
    parsedContent = JSON.parse(text)
  } catch {
    /* the raw-text config answer stays a string */
  }
  return { payload: r.structuredContent?.result, isError: r.isError === true, text, rawContent: parsedContent }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Registered project: every `cwd`-carrying action resolves a real scope. */
const CWD = '/tmp/opencode/conformance-project'
const PROJECT = 'proj-conformance'

interface Fixture {
  source: string
  target: string
  other: string
  edgeId: string
  retention: string
  proposalId: string
}

let fx: Fixture

/** Age anchor that clears the default `retentionReview.minAgeDays` (30). */
const OLD_ISO = '2020-01-01T00:00:00.000Z'

/** Insert a pending edge proposal whose fingerprint matches the live graph. */
function insertPendingEdge(db: Database, src: string, tgt: string): string {
  const source = getThoughtRow(db, src)
  const target = getThoughtRow(db, tgt)
  if (!source || !target) throw new Error('fixture thoughts missing')
  const fp = computeFingerprint({
    sourceId: src,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId: tgt,
    targetUpdatedAt: target.updated_at,
    targetStatus: target.status,
    existingEdgeType: getEdgePairBetween(db, src, tgt)?.type ?? null,
  })
  return insertProposal(db, {
    source_thought_id: src,
    item_kind: 'edge',
    target_id: tgt,
    edge_type: 'related',
    confidence: 0.8,
    rationale: 'envelope conformance fixture',
    payload: '{}',
    fingerprint: fp,
    direction: 'symmetric',
  }).id
}

function seedFixture(): void {
  const db = getDb()
  db.prepare(`INSERT INTO projects (id, name, created_at, local_path) VALUES (?, 'Conformance', ?, ?)`)
    .run(PROJECT, new Date().toISOString(), CWD)

  const source = seedThought({ content: 'conformance source alpha', tags: '["conformance"]', project_id: PROJECT })
  const target = seedThought({ content: 'conformance target beta', project_id: PROJECT })
  const other = seedThought({ content: 'conformance other delta', project_id: PROJECT })
  const retention = seedThought({
    content: 'conformance retention epsilon',
    status: 'archived',
    is_protected: 0,
    created_at: OLD_ISO,
    project_id: PROJECT
  })
  // The thoughts trigger seeds importance at 1.0, so the candidate's low
  // importance is written afterwards to clear the retention floor (0.2).
  db.prepare('UPDATE thought_importance SET importance = 0.05 WHERE thought_id = ?').run(retention)

  fx = {
    source,
    target,
    other,
    edgeId: seedEdge(source, other, 'supports'),
    retention,
    proposalId: insertPendingEdge(db, source, target)
  }
}

// ── the action table ──────────────────────────────────────────────────────────

interface ActionCase {
  tool: string
  action: string
  /** Canonical action echoed in `meta.action` when the tool aliases an action. */
  metaAction?: string
  args: (f: Fixture) => Record<string, unknown>
  slot: 'item' | 'items' | 'graph'
  /** The action's own contract accepts `cwd`; the case is called with it. */
  cwd?: boolean
  /** The answer previews a destructive write (`meta.preview.destructive === true`). */
  preview?: boolean
  /** The raw-text `config` answer is not a JSON mirror of `content`. */
  noMirror?: boolean
  /** Pinned known defect: the case asserts the contract and is expected to fail. */
  knownDefect?: string
}

const CASES: ActionCase[] = [
  // memory_recall
  { tool: 'memory_recall', action: 'search', args: () => ({ query: 'conformance source alpha' }), slot: 'items', cwd: true },
  { tool: 'memory_recall', action: 'get', args: f => ({ thought_id: f.source }), slot: 'item' },
  { tool: 'memory_recall', action: 'context', args: f => ({ thought_id: f.source }), slot: 'item', cwd: true },
  { tool: 'memory_recall', action: 'chain', args: f => ({ thought_id: f.source }), slot: 'item' },
  { tool: 'memory_recall', action: 'clusters', args: () => ({ query: 'conformance cluster' }), slot: 'items', cwd: true },
  { tool: 'memory_recall', action: 'list', args: () => ({}), slot: 'items', cwd: true },
  // memory_store
  { tool: 'memory_store', action: 'create', args: () => ({ content: 'conformance created' }), slot: 'item', cwd: true },
  { tool: 'memory_store', action: 'update', args: f => ({ thought_id: f.source, content: 'conformance updated' }), slot: 'item', cwd: true },
  { tool: 'memory_store', action: 'link', args: f => ({ source_id: f.source, target_id: f.target }), slot: 'item' },
  { tool: 'memory_store', action: 'link_batch', args: f => ({ links: [{ source: f.source, target: f.target }] }), slot: 'items' },
  { tool: 'memory_store', action: 'unlink', args: f => ({ edge_id: f.edgeId }), slot: 'item', preview: true },
  { tool: 'memory_store', action: 'unlink_batch', args: f => ({ edge_ids: [f.edgeId] }), slot: 'items', preview: true },
  { tool: 'memory_store', action: 'retype', args: f => ({ edge_id: f.edgeId, new_type: 'related' }), slot: 'item', preview: true },
  { tool: 'memory_store', action: 'bulk_create', args: () => ({ thoughts: [{ content: 'conformance bulk' }] }), slot: 'items', cwd: true },
  // memory_supersede
  { tool: 'memory_supersede', action: 'archive', args: f => ({ thought_id: f.target }), slot: 'item', preview: true },
  { tool: 'memory_supersede', action: 'archive_batch', args: f => ({ thought_ids: [f.target] }), slot: 'items', preview: true },
  { tool: 'memory_supersede', action: 'merge', args: f => ({ source_id: f.target, target_id: f.source }), slot: 'item', preview: true, cwd: true },
  // memory_status
  { tool: 'memory_status', action: 'slots', args: () => ({}), slot: 'items', cwd: true },
  { tool: 'memory_status', action: 'frontier', args: () => ({}), slot: 'items', cwd: true },
  { tool: 'memory_status', action: 'config', args: () => ({}), slot: 'item', noMirror: true },
  { tool: 'memory_status', action: 'health', args: () => ({}), slot: 'item' },
  { tool: 'memory_status', action: 'propose', args: f => ({ thought_id: f.source }), slot: 'item', cwd: true },
  // memory_manage
  { tool: 'memory_manage', action: 'list', args: () => ({}), slot: 'items', cwd: true },
  { tool: 'memory_manage', action: 'create', args: () => ({ name: 'Conformance Created', local_path: '/tmp/opencode/conformance-created' }), slot: 'item', cwd: true },
  { tool: 'memory_manage', action: 'update', args: () => ({ project_id: PROJECT, name: 'Conformance renamed' }), slot: 'item', cwd: true },
  { tool: 'memory_manage', action: 'delete', args: () => ({ project_id: PROJECT }), slot: 'item', cwd: true },
  { tool: 'memory_manage', action: 'resolve', args: () => ({}), slot: 'item', cwd: true },
  // memory_crystallize
  { tool: 'memory_crystallize', action: 'graph', args: () => ({}), slot: 'graph', cwd: true },
  { tool: 'memory_crystallize', action: 'cluster', args: f => ({ thought_ids: [f.source, f.target], title: 'conformance cluster' }), slot: 'item', cwd: true },
  { tool: 'memory_crystallize', action: 'auto_cluster', args: () => ({}), slot: 'items', preview: true },
  // memory_reflect
  { tool: 'memory_reflect', action: 'reflect', args: () => ({ summary: 'conformance reflect' }), slot: 'item', cwd: true },
  {
    tool: 'memory_reflect',
    action: 'timeline',
    args: () => ({}),
    slot: 'items',
    cwd: true
  },
  // memory_primers
  { tool: 'memory_primers', action: 'list', args: () => ({}), slot: 'items' },
  {
    tool: 'memory_primers',
    action: 'delete',
    args: () => ({ primer_id: 'missing-primer' }),
    slot: 'item'
  },
  // edge_review
  { tool: 'edge_review', action: 'enqueue', args: f => ({ thought_id: f.source }), slot: 'item', cwd: true },
  { tool: 'edge_review', action: 'list', args: () => ({}), slot: 'items', cwd: true },
  { tool: 'edge_review', action: 'apply', args: f => ({ proposal_id: f.proposalId }), slot: 'item', preview: true },
  { tool: 'edge_review', action: 'apply_batch', args: f => ({ proposal_ids: [f.proposalId] }), slot: 'items', preview: true },
  { tool: 'edge_review', action: 'rollback', args: () => ({ run_id: 'auto-conformance-run' }), slot: 'items', preview: true },
  { tool: 'edge_review', action: 'reject', args: f => ({ proposal_id: f.proposalId }), slot: 'item' },
  // retention_review
  { tool: 'retention_review', action: 'list', args: () => ({}), slot: 'items' },
  { tool: 'retention_review', action: 'protect', args: f => ({ thought_id: f.retention }), slot: 'item' },
  { tool: 'retention_review', action: 'delete', args: f => ({ thought_id: f.retention }), slot: 'item', preview: true },
  { tool: 'retention_review', action: 'compact', args: f => ({ source_ids: [f.retention], summary: { content: 'conformance summary' } }), slot: 'item', preview: true }
]

/** Tools that multiplex actions (every one must be covered above). */
const ACTION_TOOLS = [
  'edge_review',
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

// ── contract helpers ──────────────────────────────────────────────────────────

/** Top-level keys no answer may carry (pre-#2179 shapes). */
const LEGACY_KEYS = ['thoughts', 'nodes', 'best_match', 'text', 'results', 'clusters', 'edges']

/** Keys documented as booleans; a 0/1 here means the storage encoding leaked. */
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

const META_KEYS = new Set(['action', 'scope', 'counts', 'degraded', 'warnings', 'reason', 'preview'])
const REASONS = new Set(['no_match', 'id_not_found', 'ambiguous_id'])

/** Recursively enforce output hygiene: tag strings, no `{id,name}` object, no 0/1 booleans. */
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
    if (BOOLEAN_FIELDS.has(key) && value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${path}.${key} must be a boolean, got ${typeof value} (${String(value)})`)
    }
    if (key === 'tags' && Array.isArray(value)) {
      for (const tag of value) {
        if (typeof tag !== 'string') throw new Error(`${path}.tags must hold strings, got ${JSON.stringify(tag)}`)
      }
    }
    assertHygiene(value, `${path}.${key}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Assert one answer against the shared contract and return its payload so a
 * case can make a further, action-specific assertion.
 */
function assertEnvelope(c: ActionCase, result: unknown): { payload: Record<string, unknown>; meta: Record<string, unknown> } {
  const { payload, isError, text, rawContent } = readResult(result)
  if (isError) throw new Error(`${c.tool} ${c.action} answered isError: ${text}`)
  if (!isPlainObject(payload)) throw new Error(`${c.tool} ${c.action} payload is not an object: ${text}`)

  // The wire envelope is `{ result }`; content[] mirrors it except for config.
  if (!c.noMirror && JSON.stringify(rawContent) !== JSON.stringify(payload)) {
    throw new Error(`${c.tool} ${c.action}: content[] and structuredContent.result disagree`)
  }

  const keys = Object.keys(payload).sort()
  const expected = c.slot === 'graph' ? ['edges', 'items', 'meta'] : [c.slot === 'item' ? 'item' : 'items', 'meta']
  if (JSON.stringify(keys) !== JSON.stringify(expected.sort())) {
    throw new Error(`${c.tool} ${c.action}: expected exactly ${expected.join('+')}, got ${keys.join('+')}`)
  }
  for (const legacy of LEGACY_KEYS) {
    if (c.slot === 'graph' && legacy === 'edges') continue
    if (payload[legacy] !== undefined) throw new Error(`${c.tool} ${c.action}: legacy key '${legacy}' leaked`)
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
    throw new Error(`${c.tool} ${c.action}: meta.action is '${String(meta.action)}', expected '${expectedAction}'`)
  }

  const counts = meta.counts
  if (!isPlainObject(counts)) throw new Error(`${c.tool} ${c.action}: meta.counts is not an object`)
  for (const key of ['total', 'returned', 'filtered_out']) {
    if (typeof counts[key] !== 'number' || !Number.isFinite(counts[key] as number)) {
      throw new Error(`${c.tool} ${c.action}: meta.counts.${key} is not a number`)
    }
    if ((counts[key] as number) < 0) throw new Error(`${c.tool} ${c.action}: meta.counts.${key} is negative`)
  }
  const slotSize = c.slot === 'item' ? (payload.item === null ? 0 : 1) : (payload.items as unknown[]).length
  if (counts.returned !== slotSize) {
    throw new Error(`${c.tool} ${c.action}: meta.counts.returned=${String(counts.returned)} but the slot holds ${slotSize}`)
  }
  if (c.slot === 'graph' && counts.edges !== (payload.edges as unknown[]).length) {
    throw new Error(`${c.tool} ${c.action}: meta.counts.edges does not match edges.length`)
  }

  if (meta.scope !== null) {
    const scope = meta.scope
    if (!isPlainObject(scope)) throw new Error(`${c.tool} ${c.action}: meta.scope is neither null nor an object`)
    for (const key of ['project', 'project_name', 'global']) {
      if (!(key in scope)) throw new Error(`${c.tool} ${c.action}: meta.scope.${key} is missing`)
    }
    if (scope.project !== null && typeof scope.project !== 'string') throw new Error(`${c.tool} ${c.action}: meta.scope.project is not a string|null`)
    if (scope.project_name !== null && typeof scope.project_name !== 'string') throw new Error(`${c.tool} ${c.action}: meta.scope.project_name is not a string|null`)
    if (typeof scope.global !== 'boolean') throw new Error(`${c.tool} ${c.action}: meta.scope.global is not a boolean`)
  }
  if (typeof meta.degraded !== 'boolean') throw new Error(`${c.tool} ${c.action}: meta.degraded is not a boolean`)
  if (!Array.isArray(meta.warnings) || meta.warnings.some(w => typeof w !== 'string')) {
    throw new Error(`${c.tool} ${c.action}: meta.warnings is not a string[]`)
  }
  if (meta.reason !== undefined && !REASONS.has(String(meta.reason))) {
    throw new Error(`${c.tool} ${c.action}: meta.reason '${String(meta.reason)}' is not one of ${[...REASONS].join(', ')}`)
  }
  if (meta.preview !== undefined) {
    const preview = meta.preview
    if (!isPlainObject(preview)) throw new Error(`${c.tool} ${c.action}: meta.preview is not an object`)
    if (preview.destructive !== true) throw new Error(`${c.tool} ${c.action}: meta.preview.destructive must be true`)
    if (preview.token !== null && typeof preview.token !== 'string') throw new Error(`${c.tool} ${c.action}: meta.preview.token is not string|null`)
  }
  if (c.preview === true) {
    if (meta.preview === undefined) throw new Error(`${c.tool} ${c.action}: preview answer carries no meta.preview`)
    const token = isPlainObject(payload.item) ? payload.item.preview_token : undefined
    if (typeof token === 'string' && (meta.preview as Record<string, unknown>).token !== token) {
      throw new Error(`${c.tool} ${c.action}: meta.preview.token does not mirror item.preview_token`)
    }
  }

  assertHygiene(payload, `${c.tool}.${c.action}`)
  return { payload, meta }
}

// ── harness ───────────────────────────────────────────────────────────────────

async function advertisedTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
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

// ── table completeness (drift guard) ─────────────────────────────────────────

/** The two envelope phrases a description uses to introduce a shape's action list. */
const ITEMS_PHRASE = '{ items, meta } for '
const ITEM_PHRASE = '{ item, meta } for '

/**
 * The action list that follows `phrase` in `description`, cut at the nearest
 * clause boundary: `; `, a sentence end `. ` or the other envelope phrase.
 *
 * A description reads `… { items, meta } for a, b, c, { item, meta } for d, e; …`,
 * so the list can only end at one of those. Matching `[^;.]+` instead truncated
 * at the first period — inside `meta.counts` — and passed only because the action
 * names happened to precede it (task #2197).
 */
function envelopeClause(description: string, phrase: string, otherPhrase: string): string {
  const start = description.indexOf(phrase)
  if (start < 0) return ''
  const body = description.slice(start + phrase.length)
  const cuts = [body.indexOf('; '), body.indexOf('. '), body.indexOf(otherPhrase)].filter(i => i >= 0)
  return body.slice(0, cuts.length > 0 ? Math.min(...cuts) : body.length).replace(/[,\s]+$/, '')
}

/**
 * Verify that every `edge_review` action is named under the phrase of its slot
 * and by no other phrase. Throws (via `expect`) naming the offending action, so
 * the doctored-description test below can prove the check has teeth.
 */
function assertEdgeReviewDescription(description: string): void {
  const itemsClause = envelopeClause(description, ITEMS_PHRASE, ITEM_PHRASE)
  const itemClause = envelopeClause(description, ITEM_PHRASE, ITEMS_PHRASE)
  expect(itemsClause).not.toBe('')
  expect(itemClause).not.toBe('')

  const mentions = (clause: string, action: string) => new RegExp(`(^|[^a-z_])${action}([^a-z_]|$)`).test(clause)
  for (const c of CASES.filter(c => c.tool === 'edge_review')) {
    const documented = c.slot === 'item' ? itemClause : itemsClause
    const other = c.slot === 'item' ? itemsClause : itemClause
    expect({ action: c.action, documented: mentions(documented, c.action) }).toEqual({ action: c.action, documented: true })
    expect({ action: c.action, wrongClause: mentions(other, c.action) }).toEqual({ action: c.action, wrongClause: false })
  }
}

describe('action table completeness', () => {
  test('every action of every action tool is in the table, and nothing extra', async () => {
    const tools = await advertisedTools()
    const actionTools = tools.filter(t => schemaProps(t).action !== undefined)
    expect(actionTools.map(t => t.name).sort()).toEqual(ACTION_TOOLS)

    for (const tool of actionTools) {
      const advertised = ((schemaProps(tool).action as { enum?: string[] }).enum ?? []).slice().sort()
      const covered = CASES.filter(c => c.tool === tool.name).map(c => c.action).sort()
      expect(covered).toEqual(advertised)
    }
  })

  test('the edge_review description maps every action to the envelope shape it really answers', async () => {
    // The description is the only place a client learns whether an action
    // answers { items, meta } or { item, meta }; if it drifts from the table
    // above, a client following the text misses the per-row report it is sent
    // (task #2190: rollback was documented as { item, meta }).
    const tool = (await advertisedTools()).find(t => t.name === 'edge_review')
    assertEdgeReviewDescription(tool?.description ?? '')
  })

  test('the clause cut runs past the dot inside meta.counts and stops at the next phrase', () => {
    // The exact shape edge_review uses: the aggregate mention carries a period
    // (`meta.counts`), which must not end the clause.
    const description =
      'Answers the shared envelope: { items, meta } for list/apply_batch/rollback (aggregate in meta.counts), ' +
      '{ item, meta } for enqueue/apply/reject; a preview sets meta.preview={token,destructive:true}. Actions: enqueue.'

    expect(envelopeClause(description, ITEMS_PHRASE, ITEM_PHRASE)).toBe(
      'list/apply_batch/rollback (aggregate in meta.counts)'
    )
    expect(envelopeClause(description, ITEM_PHRASE, ITEMS_PHRASE)).toBe('enqueue/apply/reject')
  })

  test('the description check has teeth: a period before the action list is caught', () => {
    // Same two shapes, but the items list is split off by a sentence end — the
    // drift that the former `[^;.]+` capture would have mistaken for a list.
    const doctored =
      'Answers the shared envelope: { items, meta } for collections. list, apply_batch and rollback use that shape, ' +
      '{ item, meta } for enqueue, apply and reject; a preview sets meta.preview={token,destructive:true}.'

    expect(() => assertEdgeReviewDescription(doctored)).toThrow()
  })

  test('the graph exception is documented on memory_crystallize', async () => {
    const tool = (await advertisedTools()).find(t => t.name === 'memory_crystallize')
    expect(tool?.description).toContain('exception')
    expect(tool?.description).toContain('edges')
  })
})

// ── hard cwd contract ────────────────────────────────────────────────────────

/** Project-scoped actions that refuse to run without `cwd` (task #2179). */
const CWD_REQUIRED: Array<{ tool: string; action: string; args: Record<string, unknown> }> = [
  { tool: 'memory_recall', action: 'search', args: { query: 'conformance source alpha' } },
  { tool: 'memory_recall', action: 'clusters', args: { query: 'conformance cluster' } },
  { tool: 'memory_recall', action: 'list', args: {} },
  { tool: 'memory_status', action: 'slots', args: {} },
  { tool: 'memory_status', action: 'frontier', args: {} },
  { tool: 'memory_status', action: 'propose', args: { content: 'conformance draft proposal' } },
  { tool: 'memory_reflect', action: 'reflect', args: { summary: 'conformance reflect' } },
  { tool: 'memory_reflect', action: 'timeline', args: {} }
]

describe('cwd is required for project-scoped actions', () => {
  for (const c of CWD_REQUIRED) {
    test(`${c.tool} action=${c.action} without cwd names the fix`, async () => {
      const { isError, text } = readResult(await client.callTool({ name: c.tool, arguments: { action: c.action, ...c.args } } as never))
      expect(isError).toBe(true)
      expect(text).toContain(`cwd is required for ${c.tool} action=${c.action}`)
      expect(text).toContain('pass the project working directory')
      expect(text).toContain('memory_manage action=resolve')
    })

    test(`${c.tool} action=${c.action} with cwd succeeds`, async () => {
      const { isError } = readResult(await client.callTool({ name: c.tool, arguments: { action: c.action, ...c.args, cwd: CWD } } as never))
      expect(isError).toBe(false)
    })
  }

  test('the no-cwd rejections are non-destructive and idempotent', async () => {
    const db = getDb()
    const snapshot = () =>
      (['thoughts', 'edges', 'projects', 'placement_proposals'] as const)
        .map(table => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
        .join(':')
    const before = snapshot()
    for (let round = 0; round < 2; round++) {
      for (const c of CWD_REQUIRED) {
        const { isError } = readResult(await client.callTool({ name: c.tool, arguments: { action: c.action, ...c.args } } as never))
        expect(isError).toBe(true)
      }
      expect(snapshot()).toBe(before)
    }
  })
})

// ── shaping guarantees ───────────────────────────────────────────────────────

describe('fields selection drops scoring metadata', () => {
  test('search with fields=[id,content] returns exactly those columns plus the envelope', async () => {
    const { payload, isError } = readResult(await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'conformance source alpha', cwd: CWD, compact: false, fields: ['id', 'content'] }
    } as never))
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
    const { payload } = readResult(await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'conformance source alpha', cwd: CWD, compact: false }
    } as never))
    const item = (payload as { items: Array<Record<string, unknown>> }).items.find(i => (i.thought as { id?: string }).id === fx.source)
    expect(item).toBeDefined()
    expect(item?.scores).toBeDefined()
    expect(item?.match_source).toBeDefined()
  })
})

describe('empty and ambiguous search pass a reason through meta', () => {
  test('a query that matches nothing reports reason=no_match', async () => {
    const { payload, isError } = readResult(await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'zzzznomatchtokenxyz', cwd: CWD }
    } as never))
    expect(isError).toBe(false)
    const body = payload as { items: unknown[]; meta: Record<string, unknown> }
    expect(body.items).toEqual([])
    expect(body.meta.reason).toBe('no_match')
    expect((body.meta.counts as { total: number }).total).toBe(0)
  })

  test('an ambiguous id prefix reports reason=ambiguous_id', async () => {
    seedThought({ id: 'abcdef01-0000-7000-8000-000000000001', content: 'conformance prefix one', project_id: PROJECT })
    seedThought({ id: 'abcdef01-0000-7000-8000-000000000002', content: 'conformance prefix two', project_id: PROJECT })
    const { payload, isError } = readResult(await client.callTool({
      name: 'memory_recall',
      // 13 hex characters: the #2186 prefix floor, so this really is an id query.
      arguments: { action: 'search', query: 'abcdef0100007', cwd: CWD }
    } as never))
    expect(isError).toBe(false)
    const body = payload as { items: Array<{ thought: { id: string } }>; meta: Record<string, unknown> }
    expect(body.items.map(i => i.thought.id).sort()).toEqual([
      'abcdef01-0000-7000-8000-000000000001',
      'abcdef01-0000-7000-8000-000000000002'
    ])
    expect(body.meta.reason).toBe('ambiguous_id')
  })
})
