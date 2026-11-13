import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/server'
import { closeDb, getDb } from '../../db'
import { resolveDefaultProjectId } from '../../db/projects'
import { createTestDb } from '../../test/helpers'
import { registerMemoryReflect } from './reflect'

// This suite mocks.module('../../services/projects.service') globally — a
// singleton every MCP tool shares — and bun cannot unmock a module, so it must
// run in a child bun process with a clean module registry (task #1932: the leak
// made the full suite's memory_manage / project-scoped recall tests fail
// depending on file order). The wrapper is reflect-resolution.contract.test.ts.

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const RESOLUTION_FAILURE = 'project resolution failed (mocked)'

mock.module('../../services/projects.service', () => ({
  listProjectsService: () => [],
  getProjectService: () => null,
  createProjectService: () => {
    throw new Error('not used')
  },
  updateProjectService: () => {},
  deleteProjectService: () => ({ deleted: false, moved: 0, archivedIds: [] }),
  resolveProjectService: () => {
    throw new Error(RESOLUTION_FAILURE)
  }
}))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

function captureTool(
  register: (server: McpServer) => void
): (args: Record<string, unknown>) => Promise<unknown> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
  const fakeServer = {
    registerTool: (
      _name: string,
      _config: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      handler = cb
      return { enable: () => {}, disable: () => {}, remove: () => {} }
    }
  } as unknown as McpServer
  register(fakeServer)
  if (!handler) throw new Error('register function did not register a tool')
  return handler
}

beforeEach(createTestDb)
afterEach(closeDb)

describe('memory_reflect project resolution failure', () => {
  test('reflect with a cwd whose project resolution throws returns the isError envelope', async () => {
    const handler = captureTool(registerMemoryReflect)
    const result = (await handler({
      action: 'reflect',
      cwd: '/tmp/resolution-failure',
      summary: 'boom'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe(RESOLUTION_FAILURE)
    expect(result.structuredContent).toBeUndefined()
  })

  test('timeline with a cwd whose project resolution throws returns the isError envelope', async () => {
    const handler = captureTool(registerMemoryReflect)
    const result = (await handler({
      action: 'timeline',
      cwd: '/tmp/resolution-failure'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(RESOLUTION_FAILURE)
  })

  test('reflect without cwd writes to the default project instead of being rejected', async () => {
    const handler = captureTool(registerMemoryReflect)
    const decision = 'cwd-less reflect decision'
    const result = (await handler({
      action: 'reflect',
      decisions: [decision],
      summary: 'control run without project scope'
    })) as ToolResult

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).not.toContain(RESOLUTION_FAILURE)
    const payload = result.structuredContent?.result as {
      item: { decisions_created: number }
      meta: { scope: unknown; warnings: string[] }
    }
    expect(payload.item.decisions_created).toBe(1)
    expect(payload.meta.scope).toBeNull()
    expect(payload.meta.warnings).toEqual([])

    const row = getDb()
      .prepare('SELECT project_id FROM thoughts WHERE content = ?')
      .get(decision) as { project_id: string }
    expect(row.project_id).toBe(resolveDefaultProjectId(getDb()))
  })
})
