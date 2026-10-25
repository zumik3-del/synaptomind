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

export class InvalidEdgeTypeError extends Error {
  readonly statusCode = 400
  constructor(type: string, validTypes: string[]) {
    super(`Invalid edge type '${type}'. Valid types: ${validTypes.join(', ')}`)
    this.name = 'InvalidEdgeTypeError'
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

/**
 * A live (draft/active) thought already carries this content inside the project
 * — the `idx_thoughts_content_dedupe` invariant introduced by v046. Raised
 * instead of letting the raw `UNIQUE constraint failed` escape as a 500.
 */
export class ThoughtContentConflictError extends Error {
  readonly statusCode = 409
  constructor(existingId?: string) {
    super(
      existingId
        ? `A live thought in this project already has this content (${existingId}). ` +
          'Edit that thought or archive it before reusing the content.'
        : 'Another live thought in this project already has this content. ' +
          'Edit that thought or archive it before reusing the content.'
    )
    this.name = 'ThoughtContentConflictError'
  }
}
