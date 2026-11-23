const COMPACT_FIELDS = ['id', 'content', 'status', 'tags', 'project'] as const

interface UrlLinkView {
  text: string
  url: string
  label: string
}

export type BatchUrlLinks = Map<string, UrlLinkView[]>

export interface ShapeOptions {
  compact?: boolean
  fields?: unknown
  available?: readonly string[]
  urlLinks?: BatchUrlLinks
}

function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(v => v.length > 0)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(v => v.trim())
      .filter(v => v.length > 0)
  }
  return [String(value).trim()].filter(v => v.length > 0)
}

function stringifyTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  return tags.map(t => {
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>
      if (typeof o.name === 'string') return o.name
      if (typeof o.tag === 'string') return o.tag
      return String(o.id ?? t)
    }
    return String(t)
  })
}

const BOOLEAN_FIELDS = new Set(['is_protected', 'is_global', 'is_cluster'])

function hygienicValue(field: string, value: unknown): unknown {
  if (field === 'tags') return stringifyTags(value)
  if (BOOLEAN_FIELDS.has(field)) return value === true || value === 1
  return value
}

function hygienicEntity(entity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entity)) out[key] = hygienicValue(key, value)
  return out
}

// Explicit `fields` win over `compact`; `compact` (default true) selects COMPACT_FIELDS;
// `available` is the column ceiling of the surface; `project` is derived, never an own column.
function selectionOf(options: ShapeOptions): string[] {
  const requested = toStringArray(options.fields)
  const compact = options.compact !== false
  const raw = requested.length > 0 ? requested : compact ? [...COMPACT_FIELDS] : []
  const selection: string[] = []
  for (const field of raw) {
    if (field !== 'project' && options.available && !options.available.includes(field)) continue
    if (!selection.includes(field)) selection.push(field)
  }
  return selection
}

function projectEntity(entity: Record<string, unknown>, options: ShapeOptions): unknown {
  const selection = selectionOf(options)
  if (selection.length === 0) return hygienicEntity(entity)
  const out: Record<string, unknown> = {}
  for (const field of selection) {
    if (field === 'project') {
      const project = entity.project_name ?? entity.project ?? entity.project_id
      if (project !== undefined) out.project = project
    } else if (Object.hasOwn(entity, field)) {
      out[field] = hygienicValue(field, entity[field])
    }
  }
  return out
}

export function shapeEntity(value: unknown, options: ShapeOptions = {}): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const shaped = projectEntity(value as Record<string, unknown>, options)
  const urlLinks = options.urlLinks
  if (urlLinks === undefined || shaped === null || typeof shaped !== 'object') return shaped
  const id = (value as { id?: unknown }).id
  const links = typeof id === 'string' ? (urlLinks.get(id) ?? []) : []
  return { ...(shaped as Record<string, unknown>), url_links: links }
}
