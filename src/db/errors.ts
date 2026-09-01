export class EdgeAlreadyExistsError extends Error {
  readonly statusCode = 409
  constructor() {
    super('Edge already exists')
    this.name = 'EdgeAlreadyExistsError'
  }
}

export class ClusterEdgeValidationError extends Error {
  readonly statusCode = 400
  constructor(msg: string) {
    super(msg)
    this.name = 'ClusterEdgeValidationError'
  }
}

export class SelfLoopEdgeError extends Error {
  readonly statusCode = 400
  constructor() {
    super('Edge cannot link a thought to itself (source_id and target_id are the same)')
    this.name = 'SelfLoopEdgeError'
  }
}

export class EdgeConflictError extends Error {
  readonly statusCode = 409
  constructor(sourceId: string, targetId: string) {
    super(
      `An edge already exists between ${sourceId} and ${targetId}. Only one edge per pair of thoughts is allowed (any type, either direction).`
    )
    this.name = 'EdgeConflictError'
  }
}
