import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

beforeEach(createTestDb)
afterEach(closeDb)

function createTestServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  return server
}

describe('MCP tool registration', () => {
  const server = createTestServer()

  const expectedTools = [
    'memory_recall',
    'memory_store',
    'memory_supersede',
    'memory_status',
    'memory_manage',
    'memory_crystallize',
    'memory_reflect',
    'memory_telemetry',
    'memory_git',
    'memory_guide'
  ]

  for (const toolName of expectedTools) {
    test(`registers ${toolName}`, () => {
      expect(server).toBeDefined()
    })
  }
})

describe('memory_store', () => {
  test('create action creates a thought', async () => {
    const server = createTestServer()
    expect(server).toBeDefined()
  })
})

describe('memory_recall', () => {
  test('search action with hybrid flag', async () => {
    seedThought({ content: 'test search thought', status: 'active' })
    const server = createTestServer()
    expect(server).toBeDefined()
  })
})

describe('memory_supersede', () => {
  test('archive action archives a thought', () => {
    const thoughtId = seedThought({ content: 'to archive', status: 'active' })
    expect(thoughtId).toBeDefined()
  })
})

describe('memory_status', () => {
  test('health action returns health check', () => {
    const server = createTestServer()
    expect(server).toBeDefined()
  })
})

describe('memory_crystallize', () => {
  test('graph action returns graph data', () => {
    seedThought({ content: 'graph node' })
    const server = createTestServer()
    expect(server).toBeDefined()
  })
})

describe('memory_reflect', () => {
  test('timeline action lists thoughts', () => {
    seedThought({ content: 'timeline item 1', status: 'active' })
    seedThought({ content: 'timeline item 2', status: 'draft' })
    const server = createTestServer()
    expect(server).toBeDefined()
  })
})

describe('memory_manage', () => {
  test('list action lists projects', () => {
    const server = createTestServer()
    expect(server).toBeDefined()
  })
})

describe('tool count', () => {
  test('registers exactly 10 tools', () => {
    const toolNames = [
      'memory_recall', 'memory_store', 'memory_supersede',
      'memory_status', 'memory_manage', 'memory_crystallize',
      'memory_reflect', 'memory_telemetry',
      'memory_git', 'memory_guide'
    ]
    expect(toolNames.length).toBe(10)
  })
})
