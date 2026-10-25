import { ValidationError } from '../../errors'
import { resolveProjectService } from '../../services/projects.service'

/**
 * One answer shape for every read-side MCP action (task #2179).
 *
 * A collection action answers `{ items, meta }`, a single-object action answers
 * `{ item, meta }` (`item: null` when the action legitimately finds nothing),
 * and `meta` always carries the same keys. The envelope lives inside the
 * shared `{ result }` wire envelope (`structuredContent.result`), so the tool
 * output schema stays one stable `{ result }` shape across all actions.
 */
export interface EnvelopeScope {
  /** Resolved project id, or `null` when `cwd` matches no known project. */
  project: string | null
  /** Human-readable project name; `null` when unresolved. */
  project_name: string | null
  /** True when the answer was not restricted to one project. */
  global: boolean
}

/**
 * Why an action returned nothing, when "nothing" is not the ordinary case:
 * `no_match` (nothing scored/filtered in), `id_not_found` (an id-shaped query
 * addressed no thought) and `ambiguous_id` (an id prefix addressed several).
 */
export type EnvelopeReason = 'no_match' | 'id_not_found' | 'ambiguous_id'

/** Row accounting for one answer; zeros where the action has no such notion. */
export interface EnvelopeCounts {
  /** Rows the action considered (search: post-filter candidates; list: page total). */
  total: number
  /** Rows in `items` (or `item` when present). */
  returned: number
  /** Rows deliberately dropped from `total` (relevance gate, paging). */
  filtered_out: number
}

export interface EnvelopeMeta {
  /** Action that produced the answer (`search`, `slots`, ...). */
  action: string
  /** Project scope, or `null` for actions that are not project-scoped. */
  scope: EnvelopeScope | null
  counts: EnvelopeCounts
  /** True when the answer is degraded (semantic leg down, missing best match). */
  degraded: boolean
  /** Non-fatal notes (unknown cwd widened the scope, ...). */
  warnings: string[]
  reason?: EnvelopeReason
}

/** Envelope of a collection action: `{ items, meta }`. */
export interface CollectionEnvelope<T> {
  items: T[]
  meta: EnvelopeMeta
}

/** Envelope of a single-object action: `{ item, meta }`. */
export interface ItemEnvelope<T> {
  item: T | null
  meta: EnvelopeMeta
}

/** Per-action refinements of the envelope defaults. */
export interface EnvelopeOptions {
  scope?: EnvelopeScope | null
  total?: number
  filtered_out?: number
  degraded?: boolean
  warnings?: string[]
  reason?: EnvelopeReason
}

function buildMeta(action: string, returned: number, opts: EnvelopeOptions): EnvelopeMeta {
  const meta: EnvelopeMeta = {
    action,
    scope: opts.scope ?? null,
    counts: {
      total: opts.total ?? returned,
      returned,
      filtered_out: opts.filtered_out ?? 0
    },
    degraded: opts.degraded === true,
    warnings: opts.warnings ? [...opts.warnings] : []
  }
  if (opts.reason !== undefined) meta.reason = opts.reason
  return meta
}

/** Build the `{ items, meta }` envelope of a collection action. */
export function collectionEnvelope<T>(action: string, items: T[], opts: EnvelopeOptions = {}): CollectionEnvelope<T> {
  return { items, meta: buildMeta(action, items.length, opts) }
}

/** Build the `{ item, meta }` envelope of a single-object action. */
export function itemEnvelope<T>(action: string, item: T | null, opts: EnvelopeOptions = {}): ItemEnvelope<T> {
  return { item, meta: buildMeta(action, item === null ? 0 : 1, opts) }
}

/** Project filter a resolved scope implies (`undefined` = every project). */
export function scopeProjectId(scope: EnvelopeScope | null): string | undefined {
  return scope && !scope.global ? (scope.project ?? undefined) : undefined
}

/**
 * Resolve the project scope of an answer from `cwd`.
 *
 * `cwd` absent → no scope and a warning that the answer spans every project.
 * `cwd` unknown to the project table → a global scope with a warning; the call
 * still answers, it just is not restricted to one project.
 */
export function resolveEnvelopeScope(cwd: string | undefined): { scope: EnvelopeScope | null; warnings: string[] } {
  if (cwd === undefined) {
    return { scope: null, warnings: ['no cwd — the answer spans every project'] }
  }
  const project = resolveProjectService(cwd)
  if (!project) {
    return {
      scope: { project: null, project_name: null, global: true },
      warnings: [`cwd "${cwd}" matches no known project — the answer spans every project (check it with memory_manage action=resolve)`]
    }
  }
  return { scope: { project: project.id, project_name: project.name, global: false }, warnings: [] }
}

/**
 * Enforce the hard `cwd` requirement of a project-scoped read action.
 *
 * A missing scope used to silently widen the search to every project; it now
 * fails with an actionable error naming the argument to pass and the call that
 * checks whether the path is registered. The HTTP API keeps `cwd` optional —
 * only the MCP surface is strict.
 */
export function requireCwd(cwd: unknown, tool: string, action: string): string {
  if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd
  throw new ValidationError(
    `cwd is required for ${tool} action=${action}: pass the project working directory (the repository root) so the answer stays inside one project — a call without cwd would search every project. Run memory_manage action=resolve with that path first if the project is not registered yet.`
  )
}

/** Enforce `cwd` and resolve the scope in one step (hard-cwd actions). */
export function requireEnvelopeScope(
  cwd: unknown,
  tool: string,
  action: string
): { scope: EnvelopeScope; warnings: string[]; projectId: string | undefined } {
  const resolved = requireCwd(cwd, tool, action)
  const { scope, warnings } = resolveEnvelopeScope(resolved)
  // `resolveEnvelopeScope` only returns `null` for a missing cwd, which
  // `requireCwd` already rejected; a present-but-unknown cwd yields a scope.
  const effective = scope ?? { project: null, project_name: null, global: true }
  return { scope: effective, warnings, projectId: scopeProjectId(effective) }
}
