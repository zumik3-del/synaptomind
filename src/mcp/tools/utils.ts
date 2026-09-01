type McpTextContent = { type: 'text'; text: string }

export function jsonResult(data: unknown): { content: McpTextContent[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function errorResult(message: string): { content: McpTextContent[]; isError: true } {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}
