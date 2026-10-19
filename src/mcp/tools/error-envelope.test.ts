import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { EmbedderNotReadyError, EmbedderSendError, EmbedderTimeoutError, EmbedderUnavailableError } from '../../errors'
import { type ActionToolConfig, registerActionTool } from './action-tool'
import { errorResult } from './utils'

// Regression coverage for #1756 (audit M6): a classified, retryable embedder
// failure (statusCode 503) must surface in the MCP error envelope as
// `structuredContent.result.error.{statusCode,retryable}` — nested under
// `result` so the declared `{ result }` output schema stays satisfied — while an
// unclassified error keeps the plain `{ content, isError }` shape.

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: { error?: { message: string; statusCode?: number; retryable?: boolean } } }
  isError?: boolean
}

/** Wrap a register function in a fake server and return the registered callback. */
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

const classifiedConfig: ActionToolConfig = {
  name: 'memory_demo',
  description: 'envelope probe',
  inputSchema: { action: z.string() },
  handlers: {
    timeout: {
      run: () => {
        throw new EmbedderTimeoutError()
      }
    },
    send_failure: {
      run: () => {
        throw new EmbedderSendError()
      }
    },
    not_ready: {
      run: () => {
        throw new EmbedderNotReadyError()
      }
    },
    unavailable: {
      run: () => {
        throw new EmbedderUnavailableError()
      }
    },
    plain: {
      run: () => {
        throw new Error('handler exploded')
      }
    },
    non_error: {
      run: () => {
        throw 'bare string failure'
      }
    }
  }
}

describe('errorResult mirrors classified metadata under structuredContent.result', () => {
  test('a classified (statusCode) error nests the metadata under result', () => {
    const result = errorResult('boom', { statusCode: 503, retryable: true })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'boom' }])
    expect(result.structuredContent).toEqual({ result: { error: { message: 'boom', statusCode: 503, retryable: true } } })
  })

  test('an unclassified error keeps the plain envelope with no structuredContent', () => {
    const result = errorResult('boom')

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'boom' }])
    expect(result.structuredContent).toBeUndefined()
  })
})

describe('registerActionTool classifies thrown domain errors in the envelope', () => {
  test('a handler throwing EmbedderTimeoutError yields 503 + retryable', async () => {
    const handler = captureTool(server => registerActionTool(server, classifiedConfig))
    const result = (await handler({ action: 'timeout' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.result?.error).toEqual({
      message: 'Embedder request timed out',
      statusCode: 503,
      retryable: true
    })
  })

  test('a handler throwing EmbedderSendError yields 503 + retryable', async () => {
    const handler = captureTool(server => registerActionTool(server, classifiedConfig))
    const result = (await handler({ action: 'send_failure' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.result?.error).toEqual({
      message: 'Failed to send request to embedder process',
      statusCode: 503,
      retryable: true
    })
  })

  test('a handler throwing EmbedderUnavailableError yields 503 + retryable (#1773)', async () => {
    const handler = captureTool(server => registerActionTool(server, classifiedConfig))
    const result = (await handler({ action: 'unavailable' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.result?.error).toEqual({
      message: 'Embedder process is unavailable',
      statusCode: 503,
      retryable: true
    })
  })

  test('a handler throwing a plain Error keeps structuredContent undefined', async () => {
    const handler = captureTool(server => registerActionTool(server, classifiedConfig))
    const result = (await handler({ action: 'plain' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('handler exploded')
    expect(result.structuredContent).toBeUndefined()
  })

  test('a handler throwing a non-Error keeps structuredContent undefined', async () => {
    const handler = captureTool(server => registerActionTool(server, classifiedConfig))
    const result = (await handler({ action: 'non_error' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('memory_demo failed')
    expect(result.structuredContent).toBeUndefined()
  })
})

// The dispatcher's `{ result }` wrapper exists so the SDK's output-schema
// validation accepts the envelope; drive a classified failure through a real
// server/client pair to prove the SDK does not reject structuredContent.
describe('the retryable envelope survives the MCP SDK output-schema check', () => {
  async function configuredClient(): Promise<Client> {
    const server = new SdkMcpServer({ name: 'test', version: '0.0.0' })
    registerActionTool(server, classifiedConfig)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    return client
  }

  test('callTool returns the classified error envelope without a protocol error', async () => {
    const client = await configuredClient()
    const result = (await client.callTool({ name: 'memory_demo', arguments: { action: 'timeout' } })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.result?.error?.statusCode).toBe(503)
    expect(result.structuredContent?.result?.error?.retryable).toBe(true)
  })
})
