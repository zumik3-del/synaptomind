export const COMPACT_FIELDS = ['id', 'content', 'status', 'tags', 'project'] as const

export type FieldSelectionInput = boolean | string | string[] | Record<string, unknown>

interface ParsedFieldSelection {
  compact: boolean
  fields: string[] | undefined
  available: string[] | undefined
}

export function toStringArray(value: unknown): string[] {
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

function parseFieldSelectionArgs(args: FieldSelectionInput[]): ParsedFieldSelection {
  let compact = false
  let fields: string[] | undefined
  let available: string[] | undefined

  const arrays: string[][] = []
  for (const arg of args) {
    if (arg === undefined || arg === null) continue
    if (typeof arg === 'boolean') {
      compact = compact || arg
      continue
    }
    if (Array.isArray(arg)) {
      arrays.push(toStringArray(arg))
      continue
    }
    if (typeof arg === 'string') {
      fields = fields ?? [arg.trim()].filter(Boolean)
      continue
    }
    if (typeof arg === 'object') {
      const obj = arg as Record<string, unknown>
      if (typeof obj.compact === 'boolean') compact = compact || obj.compact
      if (typeof obj.compact === 'string') compact = compact || obj.compact === 'true'
      if (obj.fields !== undefined) fields = toStringArray(obj.fields)
      if (obj.field !== undefined && fields === undefined) fields = toStringArray(obj.field)
      if (obj.requested !== undefined && fields === undefined) fields = toStringArray(obj.requested)
      if (obj.requestedFields !== undefined && fields === undefined)
        fields = toStringArray(obj.requestedFields)
      if (obj.selected !== undefined && fields === undefined) fields = toStringArray(obj.selected)
      for (const key of [
        'available',
        'availableFields',
        'availableColumns',
        'columns',
        'all',
        'allFields',
        'valid',
        'validFields'
      ]) {
        if (obj[key] !== undefined) {
          available = toStringArray(obj[key])
          break
        }
      }
      if (obj.options !== undefined && obj.options !== null) {
        const nested = parseFieldSelectionArgs([obj.options as FieldSelectionInput])
        if (nested.compact) compact = true
        if (nested.fields !== undefined) fields = nested.fields
        if (nested.available !== undefined) available = nested.available
      }
    }
  }

  if (arrays.length >= 2) {
    if (fields === undefined) fields = arrays[0]
    if (available === undefined) available = arrays[1]
  } else if (arrays.length === 1) {
    const hasObject = args.some(a => a !== null && typeof a === 'object' && !Array.isArray(a))
    if (hasObject) {
      if (fields === undefined) fields = arrays[0]
    } else {
      if (fields === undefined) fields = arrays[0]
    }
  }

  return { compact, fields, available }
}

export function resolveFields(...args: FieldSelectionInput[]): string[] {
  const { compact, fields: rawFields, available } = parseFieldSelectionArgs(args)
  let fields = rawFields
  if (!fields || fields.length === 0) {
    fields = compact ? [...COMPACT_FIELDS] : available ? [...available] : []
  }
  if (available && available.length > 0) {
    const availSet = new Set(available)
    const out: string[] = []
    const seen = new Set<string>()
    for (const f of fields) {
      if (availSet.has(f) && !seen.has(f)) {
        out.push(f)
        seen.add(f)
      }
    }
    return out
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of fields) {
    if (!seen.has(f)) {
      out.push(f)
      seen.add(f)
    }
  }
  return out
}

export function projectFields(...args: unknown[]): unknown {
  if (args.length >= 2) {
    const second = args[1]
    if (
      Array.isArray(second) ||
      typeof second === 'string' ||
      (second !== null &&
        typeof second === 'object' &&
        ('fields' in (second as Record<string, unknown>) ||
          'compact' in (second as Record<string, unknown>)))
    ) {
      return projectFieldsImpl(args[0], args[1], ...args.slice(2))
    }
    if (Array.isArray(args[0]) || typeof args[0] === 'string') {
      return projectFieldsImpl(args[1], args[0], ...args.slice(2))
    }
  }
  return projectFieldsImpl(args[0])
}

function projectFieldsImpl(value: unknown, ...rest: unknown[]): unknown {
  let fields: string[] = []
  if (rest.length > 0) {
    const first = rest[0]
    if (
      Array.isArray(first) ||
      typeof first === 'string' ||
      (first !== null && typeof first === 'object')
    ) {
      fields = resolveFields(
        first as FieldSelectionInput,
        ...(rest.slice(1) as FieldSelectionInput[])
      )
    }
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (obj.fields !== undefined || obj.compact !== undefined) {
      fields = resolveFields(obj as FieldSelectionInput)
    }
  }
  if (fields.length === 0 && rest.length === 0) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (Array.isArray(obj.fields)) fields = toStringArray(obj.fields)
    }
  }

  const projectOne = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    if (fields.length === 0) return item
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      if (Object.hasOwn(item as object, f)) out[f] = (item as Record<string, unknown>)[f]
    }
    return out
  }

  if (Array.isArray(value)) return value.map(projectOne)
  return projectOne(value)
}
