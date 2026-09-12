import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerMemoryReflect } from './reflect'

// Regression coverage for task #169 (audit F9): the reflect action must resolve
// the project *inside* the dispatch try/catch, so a projects.service resolution
// failure becomes an isError envelope instead of escaping the tool call.

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
  deleteProjectService: () => false,
  resolveProjectService: () => {
    throw new Error(RESOLUTION_FAILURE)
  },
  resolveProjectByPathService: () => null
}))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

function captureTool(register: (server: McpServer) => void): (args: Record<string, unknown>) => Promise<unknown> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
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
    const result = (await handler({ action: 'reflect', cwd: '/tmp/resolution-failure', summary: 'boom' })) as ToolResult

    // If resolution ran outside the dispatch try this would reject instead.
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe(RESOLUTION_FAILURE)
    expect(result.structuredContent).toBeUndefined()
  })

  test('timeline with a cwd whose project resolution throws returns the isError envelope', async () => {
    const handler = captureTool(registerMemoryReflect)
    const result = (await handler({ action: 'timeline', cwd: '/tmp/resolution-failure' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(RESOLUTION_FAILURE)
  })

  test('reflect without cwd/project_id does not call resolution and succeeds', async () => {
    const handler = captureTool(registerMemoryReflect)
    const result = (await handler({ action: 'reflect', summary: 'control run without project scope' })) as ToolResult

    expect(result.isError).not.toBe(true)
  })
})
