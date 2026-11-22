export {
  EdgeAlreadyExistsError,
  ClusterEdgeValidationError,
  SelfLoopEdgeError,
  EdgeConflictError,
  InvalidEdgeTypeError,
  ThoughtContentConflictError,
  NotFoundError,
  ValidationError
} from './db/errors'

export class RetentionReviewIneligibleError extends Error {
  readonly statusCode = 409
  constructor(msg = 'Thought is not an eligible retention-review candidate') {
    super(msg)
    this.name = 'RetentionReviewIneligibleError'
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

export class EmbedderTimeoutError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Embedder request timed out') {
    super(msg)
    this.name = 'EmbedderTimeoutError'
  }
}

export class EmbedderSendError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Failed to send request to embedder process') {
    super(msg)
    this.name = 'EmbedderSendError'
  }
}

export class EmbedderUnavailableError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Embedder process is unavailable') {
    super(msg)
    this.name = 'EmbedderUnavailableError'
  }
}

export class McpHttpPortInUseError extends Error {
  readonly port: number
  constructor(port: number, cause?: unknown) {
    super(
      `mcp.httpPort ${port} is already in use — set a different port for it in config.json ` +
        `(or via SYNAPTOMIND_MCP_HTTP_PORT) and restart. The API port is unaffected by this key.`,
      { cause }
    )
    this.name = 'McpHttpPortInUseError'
    this.port = port
  }
}
