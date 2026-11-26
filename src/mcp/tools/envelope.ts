import type { GuardedOutcome } from '../../services/confirm-gate.service'
import { resolveProjectService } from '../../services/projects.service'

export interface EnvelopeScope {
  project: string | null
  project_name: string | null
  global: boolean
}

export type EnvelopeReason = 'no_match' | 'id_not_found' | 'ambiguous_id'

interface EnvelopeCounts {
  total: number
  returned: number
  filtered_out: number
  [count: string]: number
}

interface EnvelopePreview {
  token: string | null
  destructive: true
  consequence?: string
  instruction?: string
}

interface EnvelopeMeta {
  action: string
  scope: EnvelopeScope | null
  counts: EnvelopeCounts
  degraded: boolean
  warnings: string[]
  reason?: EnvelopeReason
  preview?: EnvelopePreview
}

interface CollectionEnvelope<T> {
  items: T[]
  meta: EnvelopeMeta
}

interface ItemEnvelope<T> {
  item: T | null
  meta: EnvelopeMeta
}

interface EnvelopeOptions {
  scope?: EnvelopeScope | null
  total?: number
  filtered_out?: number
  degraded?: boolean
  warnings?: string[]
  reason?: EnvelopeReason
  counts?: Record<string, number>
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

export function collectionEnvelope<T>(
  action: string,
  items: T[],
  opts: EnvelopeOptions = {}
): CollectionEnvelope<T> {
  return { items, meta: buildMeta(action, items.length, opts) }
}

export function itemEnvelope<T>(
  action: string,
  item: T | null,
  opts: EnvelopeOptions = {}
): ItemEnvelope<T> {
  return { item, meta: buildMeta(action, item === null ? 0 : 1, opts) }
}

export function scopeProjectId(scope: EnvelopeScope | null): string | undefined {
  return scope && !scope.global ? (scope.project ?? undefined) : undefined
}

export function guardedEnvelope<P, R>(
  action: string,
  outcome: GuardedOutcome<P, R>,
  opts: EnvelopeOptions = {}
): ItemEnvelope<P | R> {
  if (outcome.status === 'executed') return itemEnvelope(action, outcome.value, opts)
  return itemEnvelope(action, outcome.value, {
    ...opts,
    preview: { ...opts.preview, token: outcome.token }
  })
}

export function guardedCollectionEnvelope<
  P extends { items: unknown[] },
  R extends { items: unknown[] }
>(
  action: string,
  outcome: GuardedOutcome<P, R>,
  opts: EnvelopeOptions = {}
): CollectionEnvelope<P['items'][number] | R['items'][number]> {
  if (outcome.status === 'executed') return collectionEnvelope(action, outcome.value.items, opts)
  return collectionEnvelope(action, outcome.value.items, {
    ...opts,
    preview: { ...opts.preview, token: outcome.token }
  })
}

function cwdOf(cwd: unknown): string | undefined {
  return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
}

export function scopeForCwd(cwd: string | undefined): EnvelopeScope | null {
  if (cwd === undefined) return null
  const project = resolveProjectService(cwd)
  if (!project) return { project: null, project_name: null, global: true }
  return { project: project.id, project_name: project.name, global: false }
}

export function resolveEnvelopeScope(cwd: string | undefined): {
  scope: EnvelopeScope | null
  warnings: string[]
} {
  const scope = scopeForCwd(cwd)
  if (scope === null) {
    return { scope: null, warnings: ['no cwd — the answer spans every project'] }
  }
  if (scope.global) {
    return {
      scope,
      warnings: [
        `cwd "${cwd}" matches no known project — the answer spans every project (check it with memory_manage action=list)`
      ]
    }
  }
  return { scope, warnings: [] }
}

export function readEnvelopeScope(cwd: unknown): {
  scope: EnvelopeScope | null
  warnings: string[]
  projectId: string | undefined
} {
  const { scope, warnings } = resolveEnvelopeScope(cwdOf(cwd))
  return { scope, warnings, projectId: scopeProjectId(scope) }
}

export function writeEnvelopeScope(cwd: unknown): {
  scope: EnvelopeScope | null
  warnings: string[]
} {
  return { scope: scopeForCwd(cwdOf(cwd)), warnings: [] }
}
