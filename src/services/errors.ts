export { EdgeAlreadyExistsError, ClusterEdgeValidationError, SelfLoopEdgeError, EdgeConflictError } from '../db/errors'

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
