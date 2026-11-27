import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { getDb } from '../../db'
import { closeDb } from '../../db/init'
import { createProjectService } from '../../services/projects.service'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

const SRC_DIR = resolve(import.meta.dir, '..', '..')
const UNSCOPED_CWD = '/tmp/t2693-unscoped'
const LOCAL_PATH = '/tmp/t2693-local-path'

const SURVIVING_TOOLS = [
  'memory_crystallize',
  'memory_guide',
  'memory_primers',
  'memory_projects',
  'memory_recall',
  'memory_reflect',
  'memory_retention',
  'memory_status',
  'memory_store',
  'memory_supersede'
]

const REDUCED_ENUMS: Record<string, string[]> = {
  memory_recall: ['search', 'get', 'context', 'chain', 'list'],
  memory_reflect: ['reflect'],
  memory_projects: ['list', 'create', 'update', 'delete'],
  memory_retention: ['list', 'delete', 'compact']
}

const CUT_ACTIONS = [
  {
    tool: 'memory_recall',
    action: 'clusters',
    hint: 'clusters was removed; use search with is_cluster=true'
  },
  {
    tool: 'memory_reflect',
    action: 'timeline',
    hint: 'timeline was removed; use memory_recall action=list'
  },
  {
    tool: 'memory_projects',
    action: 'resolve',
    hint: 'resolve was removed; use action=list and match local_path'
  },
  {
    tool: 'memory_retention',
    action: 'protect',
    hint: 'protect was removed; use memory_store action=update with is_protected=true'
  }
]

const CUT_NAMES = CUT_ACTIONS.map(cut => cut.action)

let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: 'cut-actions', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'cut-actions-client', version: '0.0.0' })
  await client.connect(clientTransport)
})
beforeEach(createTestDb)
afterEach(closeDb)

function callTool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0])
}

interface ReadResult {
  text: string
  isError: boolean
  error?: { message?: string }
}

function readResult(result: unknown): ReadResult {
  const parsed = result as {
    content: Array<{ text: string }>
    structuredContent?: { result?: { error?: { message?: string } } }
    isError?: boolean
  }
  return {
    text: parsed.content?.[0]?.text ?? '',
    isError: parsed.isError === true,
    error: parsed.structuredContent?.result?.error
  }
}

function toolText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

function actionEnumOf(
  tools: Array<{ name: string; inputSchema?: unknown }>,
  tool: string
): string[] | undefined {
  const schema = tools.find(entry => entry.name === tool)?.inputSchema as
    | { properties?: Record<string, { enum?: string[] }> }
    | undefined
  return schema?.properties?.action?.enum
}

/** The `## Tools` table of the in-band guide, as tool name -> action cell. */
function guideToolRows(text: string): Map<string, string> {
  const start = text.indexOf('## Tools')
  const end = text.indexOf('\n## ', start + 1)
  const rows = new Map<string, string>()
  for (const line of text.slice(start, end < 0 ? undefined : end).split('\n')) {
    const match = /^\| ([a-z_]+) \| ([^|]+) \|$/.exec(line)
    if (match) rows.set(match[1] as string, match[2] as string)
  }
  return rows
}

function productionFiles(dir: string = SRC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    if (!entry.name.endsWith('.ts')) return []
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.suite.ts')) return []
    if (relative(SRC_DIR, path).startsWith('test/')) return []
    return [path]
  })
}

// A cut action may only survive as prose (the retirement hint) or as a domain word (`cluster
// thoughts`, `resolved project`). These detectors name the shapes a leftover would take: a handler
// entry, an envelope action literal, a comparison against the action, a reader still threaded the
// removed action name, a hint phrased as `action=<cut>`, and the deleted protect symbols.
const DETECTORS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'handler key', pattern: /^ {2}(clusters|timeline|resolve|protect):\s*\{/m },
  {
    label: 'envelope action literal',
    pattern:
      /(?:itemEnvelope|collectionEnvelope|guardedEnvelope|guardedCollectionEnvelope)\(\s*['"](?:clusters|timeline|resolve|protect)['"]/
  },
  {
    label: 'action comparison',
    pattern: /\baction\s*(?:===|!==)\s*['"](?:clusters|timeline|resolve|protect)['"]/
  },
  {
    label: 'removed action argument to a shared reader',
    pattern: /(?:listPage|finalizeSearchAction)\(\s*['"]/
  },
  { label: 'action=<cut> reference', pattern: /action=(?:clusters|timeline|resolve|protect)\b/ },
  {
    label: 'deleted protect symbol',
    pattern: /protectRetentionReviewCandidateService|RetentionReviewProtectOptions/
  }
]

function leftoversIn(source: string): string[] {
  return DETECTORS.filter(detector => detector.pattern.test(source)).map(detector => detector.label)
}

function sourceLeftovers(): string[] {
  const hits: string[] = []
  for (const file of productionFiles()) {
    for (const label of leftoversIn(readFileSync(file, 'utf8'))) {
      hits.push(`${relative(SRC_DIR, file)} :: ${label}`)
    }
  }
  return hits
}

describe('the reduced action surface', () => {
  test('tools/list advertises exactly the ten surviving tools', async () => {
    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name).sort()).toEqual(SURVIVING_TOOLS)
  })

  test('the four cut tools advertise exactly their surviving actions', async () => {
    const { tools } = await client.listTools()

    for (const [tool, expected] of Object.entries(REDUCED_ENUMS)) {
      expect({ tool, actions: actionEnumOf(tools, tool) }).toEqual({ tool, actions: expected })
    }
  })

  test('no advertised action enum still offers a cut action', async () => {
    const { tools } = await client.listTools()
    const offered = tools.flatMap(tool => actionEnumOf(tools, tool.name) ?? [])
    const offeredCuts = offered.filter(action => CUT_NAMES.includes(action))

    expect(offeredCuts).toEqual([])
  })
})

describe('a caller following an older reference is redirected', () => {
  for (const cut of CUT_ACTIONS) {
    test(`${cut.tool} action=${cut.action} answers its replacement hint, not an enum refusal`, async () => {
      const { text, isError, error } = readResult(await callTool(cut.tool, { action: cut.action }))

      expect(isError).toBe(true)
      expect(text).toBe(cut.hint)
      expect(text).not.toContain('Invalid option')
      expect(text).not.toContain('Invalid input')
      expect(text).not.toContain('is required')
      expect(error?.message).toBe(cut.hint)
    })

    test(`the ${cut.action} hint names a tool the surface still serves`, () => {
      const namedTools = cut.hint.match(/memory_[a-z_]+/g) ?? []
      const namedActions = [...cut.hint.matchAll(/action=([a-z_]+)/g)].map(
        match => match[1] as string
      )

      for (const tool of namedTools) expect(SURVIVING_TOOLS).toContain(tool)
      expect(namedActions).not.toContain(cut.action)
    })
  }
})

describe('the guide and the advertised descriptions name no cut action', () => {
  test('every guide tool-table row lists only surviving actions', async () => {
    const rows = guideToolRows(toolText(await callTool('memory_guide', {})))
    const listed = [...rows.values()].flatMap(cell =>
      cell
        .split(',')
        .map(action => action.trim())
        .filter(action => action.length > 0)
    )
    const listedCuts = listed.filter(action => CUT_NAMES.includes(action))

    expect(listedCuts).toEqual([])
  })

  test('the guide rows for the four cut tools match the advertised enums', async () => {
    const { tools } = await client.listTools()
    const rows = guideToolRows(toolText(await callTool('memory_guide', {})))
    const recorded = Object.fromEntries(
      [...rows.entries()].map(([tool, cell]) => [
        tool,
        cell
          .split(',')
          .map(action => action.trim())
          .filter(action => action.length > 0)
      ])
    )

    for (const tool of Object.keys(REDUCED_ENUMS)) {
      expect({ tool, guide: recorded[tool], advertised: actionEnumOf(tools, tool) }).toEqual({
        tool,
        guide: REDUCED_ENUMS[tool],
        advertised: REDUCED_ENUMS[tool]
      })
    }
  })

  test('the guide carries no action=<cut> reference', async () => {
    const text = toolText(await callTool('memory_guide', {}))

    for (const cut of CUT_NAMES) expect(text).not.toContain(`action=${cut}`)
  })

  test('no advertised tool description carries an action=<cut> reference', async () => {
    const { tools } = await client.listTools()
    const offenders = tools
      .filter(tool => CUT_NAMES.some(cut => (tool.description ?? '').includes(`action=${cut}`)))
      .map(tool => tool.name)

    expect(offenders).toEqual([])
  })
})

describe('the sources keep no handler or symbol for a cut action', () => {
  test('no production module under src/ carries a leftover', () => {
    expect(sourceLeftovers()).toEqual([])
  })

  test('the scan has teeth: a reintroduced handler, envelope literal or symbol is caught', () => {
    expect(leftoversIn('const handlers = {\n  timeline: {\n    run() {}\n  }\n}')).toEqual([
      'handler key'
    ])
    expect(leftoversIn("return itemEnvelope('protect', row)")).toEqual(['envelope action literal'])
    expect(leftoversIn("if (args.action === 'clusters') return null")).toEqual([
      'action comparison'
    ])
    expect(leftoversIn('protectRetentionReviewCandidateService(id)')).toEqual([
      'deleted protect symbol'
    ])
  })
})

describe('the moved capability survives on the replacement path', () => {
  function seedPage(): { first: string; second: string; third: string } {
    const first = seedThought({
      content: 'PAGE_MARKER oldest',
      created_at: '2026-01-01T00:00:00.000Z'
    })
    const second = seedThought({
      content: 'PAGE_MARKER middle',
      created_at: '2026-01-02T00:00:00.000Z'
    })
    const third = seedThought({
      content: 'PAGE_MARKER newest',
      created_at: '2026-01-03T00:00:00.000Z'
    })
    return { first, second, third }
  }

  test('timeline reader: memory_recall list pages with limit/offset and reports the total', async () => {
    const { second } = seedPage()
    const { text, isError } = readResult(
      await callTool('memory_recall', {
        action: 'list',
        cwd: UNSCOPED_CWD,
        limit: 1,
        offset: 1
      })
    )
    const page = JSON.parse(text)

    expect(isError).toBe(false)
    expect(page.meta.action).toBe('list')
    expect(page.items.map((item: { id: string }) => item.id)).toEqual([second])
    expect(page.meta.counts.limit).toBe(1)
    expect(page.meta.counts.offset).toBe(1)
    expect(page.meta.counts.total).toBe(3)
    expect(page.meta.counts.returned).toBe(1)
  })

  test('timeline reader: list rows are compact by default and widen with compact=false', async () => {
    seedPage()
    const compact = JSON.parse(
      toolText(await callTool('memory_recall', { action: 'list', cwd: UNSCOPED_CWD }))
    )
    const full = JSON.parse(
      toolText(
        await callTool('memory_recall', {
          action: 'list',
          cwd: UNSCOPED_CWD,
          compact: false
        })
      )
    )

    expect(Object.keys(compact.items[0]).sort()).toEqual([
      'content',
      'id',
      'project',
      'status',
      'tags'
    ])
    expect(Object.keys(full.items[0])).toEqual(
      expect.arrayContaining(['created_at', 'is_protected', 'is_cluster', 'source'])
    )
  })

  test('resolve reader: memory_projects list exposes local_path, so a path resolves by match', async () => {
    const project = createProjectService({ name: 'CutResolveProject', local_path: LOCAL_PATH })
    const { text, isError } = readResult(await callTool('memory_projects', { action: 'list' }))
    const listed = JSON.parse(text)

    expect(isError).toBe(false)
    expect(listed.meta.action).toBe('list')
    expect(
      listed.items.find((item: { local_path?: string }) => item.local_path === LOCAL_PATH)
    ).toEqual(expect.objectContaining({ id: project.id, name: 'CutResolveProject' }))
  })

  test('resolve reader: an unknown cwd warns and points at the live list action', async () => {
    const page = JSON.parse(
      toolText(await callTool('memory_recall', { action: 'list', cwd: UNSCOPED_CWD }))
    )
    const warning = page.meta.warnings.find((line: string) =>
      line.includes('matches no known project')
    )

    expect(warning).toContain('check it with memory_projects action=list')
    expect(page.meta.scope).toEqual({ project: null, project_name: null, global: true })
  })

  test('protect replacement: memory_store update is_protected=true drops the row out of the candidate list', async () => {
    const old = '2026-09-01T00:00:00.000Z'
    const id = seedThought({
      content: 'CUT_PROTECT_MARKER retention candidate',
      status: 'archived',
      is_protected: 0,
      importance: 0.1,
      created_at: old
    })
    getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run(old, id)
    getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)

    const before = JSON.parse(
      toolText(
        await callTool('memory_retention', {
          action: 'list',
          min_age_days: 1,
          importance_floor: 1,
          limit: 10
        })
      )
    )
    expect(before.items.map((item: { id: string }) => item.id)).toContain(id)

    const protectedRow = readResult(
      await callTool('memory_store', {
        action: 'update',
        thought_id: id,
        is_protected: true
      })
    )
    expect(protectedRow.isError).toBe(false)
    expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({
      is_protected: 1
    })

    const after = JSON.parse(
      toolText(
        await callTool('memory_retention', {
          action: 'list',
          min_age_days: 1,
          importance_floor: 1,
          limit: 10
        })
      )
    )
    expect(after.items.map((item: { id: string }) => item.id)).not.toContain(id)
  })
})
