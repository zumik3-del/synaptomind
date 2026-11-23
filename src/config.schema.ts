/**
 * The per-key schema every config value passes through, whichever layer carried it. One failure
 * rule for config.json and the environment alike: an invalid value (wrong type, non-finite, outside
 * a declared bound) is replaced by the default with exactly one warning naming the key, the rejected
 * value and the default. Nothing is clamped — a bound either holds or the value falls back.
 *
 * A bound is declared only where a consumer already constrains that value; the default is never a
 * substitute for a legitimate boundary value (0 is accepted wherever 0 means something).
 */

export type EnvType = 'string' | 'int' | 'float' | 'bool' | 'list'

export interface SchemaEntry {
  /** Environment variable that carries the value. */
  env: string
  /** Dotted path in the resolved config object. */
  path: string
  /** The declared type, shared by the config.json and the environment layer. */
  type: EnvType
  /** Inclusive lower bound; a value below it falls back to the default. */
  min?: number
  /** Inclusive upper bound; a value above it falls back to the default. */
  max?: number
  /**
   * A closed set that aborts the load instead of falling back (`embedder.dtype`): silently switching
   * a typo to the default would point the loader at files it never validated.
   */
  assert?: (value: unknown, source: string) => void
}

const TYPE_TEXT: Record<EnvType, string> = {
  string: 'a string',
  int: 'an integer',
  float: 'a finite number',
  bool: 'true or false',
  list: 'a comma-separated list'
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getNested(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (!isPlainObject(current)) return undefined
    current = current[key]
  }
  return current
}

/**
 * Writes `value` at `path`, cloning every object on the way down. The config object shares untouched
 * sections with `DEFAULTS` (a shallow merge), so writing in place would corrupt the defaults.
 */
export function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const next = current[keys[i]]
    const clone = isPlainObject(next) ? { ...next } : {}
    current[keys[i]] = clone
    current = clone
  }
  current[keys[keys.length - 1]] = value
}

function matchesType(value: unknown, type: EnvType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'list':
      return Array.isArray(value) && value.every(item => typeof item === 'string')
  }
}

function withinBounds(value: number, entry: SchemaEntry): boolean {
  if (entry.min !== undefined && value < entry.min) return false
  if (entry.max !== undefined && value > entry.max) return false
  return true
}

function isValidValue(value: unknown, entry: SchemaEntry): boolean {
  if (!matchesType(value, entry.type)) return false
  return typeof value === 'number' ? withinBounds(value, entry) : true
}

function expectedText(entry: SchemaEntry): string {
  const base = TYPE_TEXT[entry.type]
  if (entry.min !== undefined && entry.max !== undefined)
    return `${base} in [${entry.min},${entry.max}]`
  if (entry.min !== undefined) return `${base} >= ${entry.min}`
  if (entry.max !== undefined) return `${base} <= ${entry.max}`
  return base
}

export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && !Number.isFinite(value)) return `"${String(value)}"`
  return JSON.stringify(value) ?? String(value)
}

type ParsedEnvValue = { ok: true; value: unknown } | { ok: false }

export function parseEnvValue(raw: string, type: EnvType): ParsedEnvValue {
  const text = raw.trim()
  switch (type) {
    case 'string':
      return { ok: true, value: raw }
    case 'int': {
      if (text === '') return { ok: false }
      const n = Number(text)
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: false }
    }
    case 'float': {
      if (text === '') return { ok: false }
      const n = Number(text)
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false }
    }
    case 'bool':
      if (text === 'true') return { ok: true, value: true }
      if (text === 'false') return { ok: true, value: false }
      return { ok: false }
    case 'list':
      return {
        ok: true,
        value: raw
          .split(',')
          .map(item => item.trim())
          .filter(Boolean)
      }
  }
}

function reportInvalid(
  path: string,
  value: unknown,
  expected: string,
  fallback: unknown,
  env?: string
): void {
  const origin = env === undefined ? '' : ` (from ${env})`
  console.error(
    `[config] invalid value for ${path}${origin}: ${describeValue(value)} (expected ${expected}), using default ${describeValue(fallback)}`
  )
}

/**
 * Repairs a section the file replaced with a non-object (e.g. `"primer": "abc"`) before any value is
 * read from it, so the per-key pass below only ever sees a shaped tree.
 */
export function repairSections(
  merged: Record<string, unknown>,
  defaults: Record<string, unknown>,
  entries: readonly SchemaEntry[]
): void {
  const seen = new Set<string>()
  for (const { path } of entries) {
    const keys = path.split('.')
    for (let depth = 1; depth < keys.length; depth++) {
      const prefix = keys.slice(0, depth).join('.')
      if (seen.has(prefix)) continue
      seen.add(prefix)
      const current = getNested(merged, prefix)
      if (isPlainObject(current)) continue
      const fallback = getNested(defaults, prefix)
      setNested(merged, prefix, fallback)
      reportInvalid(prefix, current, 'an object', fallback)
    }
  }
}

/** The per-key pass: one warning per rejected value, and the default in its place. */
export function applySchema(
  merged: Record<string, unknown>,
  defaults: Record<string, unknown>,
  entries: readonly SchemaEntry[]
): void {
  for (const entry of entries) {
    const value = getNested(merged, entry.path)
    const fromEnv = process.env[entry.env] !== undefined
    if (entry.assert) {
      entry.assert(value, fromEnv ? entry.env : 'config.json')
      continue
    }
    if (isValidValue(value, entry)) continue
    const fallback = getNested(defaults, entry.path)
    setNested(merged, entry.path, fallback)
    reportInvalid(entry.path, value, expectedText(entry), fallback, fromEnv ? entry.env : undefined)
  }
}
