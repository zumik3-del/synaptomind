import { resolveProjectService } from '../../services/projects.service'

export interface EnvelopeScope {
  project: string | null
  project_name: string | null
  global: boolean
}

export type EnvelopeReason = 'no_match' | 'id_not_found' | 'ambiguous_id'

export interface EnvelopeCounts {
  total: number
  returned: number
  filtered_out: number
  [count: string]: number
}

export interface EnvelopePreview {
  token: string | null
  destructive: true
  consequence?: string
  instruction?: string
}

export interface EnvelopeMeta {
  action: string
  scope: EnvelopeScope | null
  counts: EnvelopeCounts
  degraded: boolean
  warnings: string[]
  reason?: EnvelopeReason
  preview?: EnvelopePreview
}

export interface CollectionEnvelope<T> {
  items: T[]
  meta: EnvelopeMeta
}

export interface ItemEnvelope<T> {
  item: T | null
  meta: EnvelopeMeta
}

export interface EnvelopeOptions {
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

function scopeForCwd(cwd: string): EnvelopeScope {
  const project = resolveProjectService(cwd)
  if (!project) return { project: null, project_name: null, global: true }
  return { project: project.id, project_name: project.name, global: false }
}

export function resolveEnvelopeScope(cwd: string | undefined): {
  scope: EnvelopeScope | null
  warnings: string[]
} {
  if (cwd === undefined) {
    return { scope: null, warnings: ['no cwd — the answer spans every project'] }
  }
  const scope = scopeForCwd(cwd)
  if (scope.global) {
    return {
      scope,
      warnings: [
        `cwd "${cwd}" matches no known project — the answer spans every project (check it with memory_manage action=resolve)`
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
  const { scope, warnings } = resolveEnvelopeScope(
    typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
  )
  return { scope, warnings, projectId: scopeProjectId(scope) }
}

export function writeEnvelopeScope(cwd: unknown): {
  scope: EnvelopeScope | null
  warnings: string[]
} {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return { scope: null, warnings: [] }
  return { scope: scopeForCwd(cwd), warnings: [] }
}
