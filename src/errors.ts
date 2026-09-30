export {
  EdgeAlreadyExistsError,
  ClusterEdgeValidationError,
  SelfLoopEdgeError,
  EdgeConflictError,
  InvalidEdgeTypeError
} from './db/errors'

export class NotFoundError extends Error {
  readonly statusCode = 404
  constructor(msg = 'Not found') {
    super(msg)
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends Error {
  readonly statusCode = 400
  constructor(msg: string) {
    super(msg)
    this.name = 'ValidationError'
  }
}

export class EmbedderNotReadyError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Embedder model is not ready') {
    super(msg)
    this.name = 'EmbedderNotReadyError'
  }
}

export class EmbedderOverloadedError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Embedder is overloaded; try again later') {
    super(msg)
    this.name = 'EmbedderOverloadedError'
  }
}

/**
 * The MCP HTTP listener could not bind. Distinct from a generic startup crash
 * because the operator's remedy is a specific config key, not "check the logs":
 * the process dies with this error, so the deploy gate can only observe a failed
 * health check on the API port and otherwise points at the wrong listener.
 */
export class McpHttpPortInUseError extends Error {
  readonly port: number
  constructor(port: number, cause?: unknown) {
    super(
      `mcp.httpPort ${port} is already in use — set a different port for it in config.json ` +
        `(or via SYNAPTOMIND_MCP_HTTP_PORT) and restart. The API port is unaffected by this key.`,
      { cause },
    )
    this.name = 'McpHttpPortInUseError'
    this.port = port
  }
}
