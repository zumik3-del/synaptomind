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
 * The embedder child did not answer an IPC request within the client timeout.
 * Transient by nature (a slow model load or a saturated queue), so it is
 * retryable and maps to HTTP 503 like the other availability errors.
 */
export class EmbedderTimeoutError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Embedder request timed out') {
    super(msg)
    this.name = 'EmbedderTimeoutError'
  }
}

/**
 * The request could not be handed to the embedder child (its IPC pipe threw).
 * The client latches the child as crashed, so the caller can retry once the
 * process is respawned; retryable and mapped to HTTP 503.
 */
export class EmbedderSendError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Failed to send request to embedder process') {
    super(msg)
    this.name = 'EmbedderSendError'
  }
}

/**
 * The embedder child is gone while requests were still in flight — it exited
 * on its own ('exiting' idle unload), crashed, or was deliberately torn down
 * (shutdown/restart). Transient: the client respawns the child, so the caller
 * can retry; maps to HTTP 503 like the other availability errors.
 */
export class EmbedderUnavailableError extends Error {
  readonly statusCode = 503
  constructor(msg = 'Embedder process is unavailable') {
    super(msg)
    this.name = 'EmbedderUnavailableError'
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
