import { ValidationError } from '../../errors'
import { resolveProjectService } from '../../services/projects.service'

/**
 * One answer shape for every MCP action (tasks #2179 read side, #2181 write side).
 *
 * A collection action answers `{ items, meta }`, a single-object action answers
 * `{ item, meta }` (`item: null` when the action legitimately finds nothing),
 * and `meta` always carries the same keys. `memory_crystallize action=graph` is
 * the one documented exception: its nodes are `items` and its edges ride beside
 * them as `edges`. The envelope lives inside the shared `{ result }` wire
 * envelope (`structuredContent.result`), so the tool output schema stays one
 * stable `{ result }` shape across all actions.
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
  /**
   * Action-specific counters beside the three shared ones — a batch reports its
   * outcome here (`linked`/`failed`, `archived`/`failed`, `deleted`/`failed`,
   * `created`/`failed`, `reverted`/`skipped`/`refused`, ...), so a caller never
   * has to count the items itself.
   */
  [count: string]: number
}

/**
 * `meta.preview` — the one place a client gates a confirm on (task #2181).
 *
 * Present only on a non-mutating preview answer. Confirming such an answer
 * mutates data, so `destructive` is always `true`; `token` is the value the
 * confirm call must send, and `null` for the tokenless previews (`unlink_batch`,
 * the retention compact step). `consequence`/`instruction` hold the batch-level
 * description of the pending write: a collection envelope has no single `item`
 * to carry them, and the per-item rows already carry their own status.
 */
export interface EnvelopePreview {
  /** Token a confirm call must send back; `null` when the preview issues none. */
  token: string | null
  /** Confirming this preview writes to the graph. */
  destructive: true
  /** What confirming would do, in one sentence. */
  consequence?: string
  /** The exact call that confirms this preview. */
  instruction?: string
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
  /** Preview gate: set only when the answer previews a destructive write. */
  preview?: EnvelopePreview
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
  /** Action-specific counters merged into `meta.counts` (never overriding the shared three). */
  counts?: Record<string, number>
  /**
   * Marks the answer as a preview: mirrors the token and the confirming step
   * into `meta.preview`. Omit for an executed answer.
   */
  preview?: { token?: string | null; consequence?: string; instruction?: string }
}

function buildPreview(opts: NonNullable<EnvelopeOptions['preview']>): EnvelopePreview {
  const preview: EnvelopePreview = { token: opts.token ?? null, destructive: true }
  if (opts.consequence !== undefined) preview.consequence = opts.consequence
  if (opts.instruction !== undefined) preview.instruction = opts.instruction
  return preview
}

function buildMeta(action: string, returned: number, opts: EnvelopeOptions): EnvelopeMeta {
  const meta: EnvelopeMeta = {
    action,
    scope: opts.scope ?? null,
    counts: {
      ...(opts.counts ?? {}),
      total: opts.total ?? returned,
      returned,
      filtered_out: opts.filtered_out ?? 0
    },
    degraded: opts.degraded === true,
    warnings: opts.warnings ? [...opts.warnings] : []
  }
  if (opts.reason !== undefined) meta.reason = opts.reason
  if (opts.preview !== undefined) meta.preview = buildPreview(opts.preview)
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
 * checks whether the path is registered. The MCP surface is the only agent
 * wire since the 0.20 HTTP shrink, so every project-scoped read is strict.
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

/**
 * Resolve the scope of a write answer (task #2181).
 *
 * A write action keeps `cwd` optional, so unlike the read side there is nothing
 * to enforce: `cwd` given → its project scope (with the "unknown cwd" warning
 * when the path is not registered); `cwd` absent → no scope and no warning,
 * because the write lands in the resolved default project rather than spanning
 * every project.
 */
export function writeEnvelopeScope(cwd: unknown): { scope: EnvelopeScope | null; warnings: string[] } {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return { scope: null, warnings: [] }
  return resolveEnvelopeScope(cwd)
}
