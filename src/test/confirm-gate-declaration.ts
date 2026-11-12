/**
 * Reads a converted action's fingerprint input set out of its own declaration
 * (task #2492).
 *
 * Every guarded action folds the state a confirm must still see into one
 * `fingerprintOf(...)` call, and the parts of that call are the only inputs the
 * stamp protects. A hand-kept list of them in the test would be a second source
 * of truth that silently rots, so the list is parsed from the tool module
 * instead: the action is located by the `kind:` it declares on its `runGuarded`
 * call (that string is the token scope, already pinned by the runtime token
 * row), and its parts are the top-level arguments of the `fingerprintOf(...)`
 * that call uses — inline, or through the `const` it closes over.
 *
 * A declaration this module cannot read is an error, never an empty set: a
 * silently empty set would make the matrix vacuously green.
 *
 * Test-only, under `src/test/` so neither this parser nor its `node:fs` import
 * reaches the production path.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

export interface FingerprintDeclaration {
  /** The token scope the action declares (`unlink`, `apply_batch`, ...). */
  kind: string
  /** The `src/`-relative module holding the declaration. */
  module: string
  /** One normalized source expression per top-level `fingerprintOf(...)` argument. */
  parts: string[]
}

/** One probe key resolved onto the declared part it identifies. */
export interface PartBinding {
  part: string
  key: string
}

/** Collapse the line breaks and indentation a multi-line argument arrives with. */
export function normalizePart(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
/** Index of the character that closes the bracket at `open`, quote-aware. */
function matchingBracket(source: string, open: number): number {
  const opener = source[open]
  const closer = CLOSERS[opener]
  if (closer === undefined) throw new Error(`not a bracket at ${open}: ${opener}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = matchingQuote(source, i, ch) - 1
      continue
    }
    if (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`unbalanced '${opener}' at ${open}`)
}

/** Index just past the quote at `start`, including any `${...}` inside a template. */
function matchingQuote(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = matchingBracket(source, i + 1)
      continue
    }
    if (ch === quote) return i + 1
  }
  throw new Error(`unterminated string at ${start}`)
}

/** Split an argument list on its top-level commas. */
function splitArguments(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = matchingQuote(text, i, ch)
      current += text.slice(i, end)
      i = end - 1
      continue
    }
    if (CLOSERS[ch] !== undefined) depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(normalizePart(current))
      current = ''
      continue
    }
    current += ch
  }
  if (normalizePart(current).length > 0) parts.push(normalizePart(current))
  return parts
}

/** The arguments of the `fingerprintOf(` call that starts at `at`. */
function fingerprintArguments(source: string, at: number): string[] {
  const open = source.indexOf('(', at)
  if (open === -1) throw new Error('fingerprintOf without an argument list')
  return splitArguments(source.slice(open + 1, matchingBracket(source, open)))
}

function onlyOccurrence(source: string, needle: string, what: string): number {
  const first = source.indexOf(needle)
  if (first === -1) throw new Error(`no ${what} (${needle})`)
  if (source.indexOf(needle, first + 1) !== -1) throw new Error(`${what} (${needle}) is ambiguous`)
  return first
}

/**
 * The fingerprint input set an action declares, read from its source.
 *
 * Throws when the action's `kind:` is missing or ambiguous, when it has no
 * `runGuarded` call, or when the call's fingerprint cannot be resolved to one
 * `fingerprintOf(...)` — a declaration the matrix cannot read must fail the
 * suite rather than shrink it.
 */
export function fingerprintDeclaration(module: string, kind: string): FingerprintDeclaration {
  const source = readFileSync(join(REPO_ROOT, module), 'utf8')
  const anchor = onlyOccurrence(source, `kind: '${kind}'`, 'guarded run')
  const callStart = source.lastIndexOf('runGuarded(', anchor)
  if (callStart === -1) throw new Error(`${module}: '${kind}' is not inside a runGuarded call`)
  const blockEnd = matchingBracket(source, source.indexOf('(', callStart))
  if (anchor > blockEnd) throw new Error(`${module}: '${kind}' sits outside its runGuarded call`)
  const block = source.slice(callStart, blockEnd + 1)

  const inline = block.indexOf('fingerprintOf(')
  if (inline !== -1) {
    return { kind, module, parts: fingerprintArguments(block, inline) }
  }

  const reference = /fingerprint:\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)/.exec(block)
  if (reference === null) {
    throw new Error(`${module}: '${kind}' declares no fingerprint expression`)
  }
  const name = reference[1]
  const declared = onlyOccurrence(source, `const ${name} = fingerprintOf(`, 'fingerprint const')
  return { kind, module, parts: fingerprintArguments(source, declared) }
}

/**
 * Bind every probe key to the one declared part it identifies.
 *
 * The binding is a bijection, checked in both directions: a declared part no
 * key identifies (a new fold input) and a key matching no part or two parts (a
 * stale probe) both throw. That is what keeps the probe matrix from drifting
 * away from the declaration — the parts themselves are never listed by hand.
 */
export function bindProbeKeys(parts: readonly string[], keys: readonly string[]): PartBinding[] {
  const bindings = parts.map(part => {
    const matches = keys.filter(key => part.includes(key))
    if (matches.length !== 1) {
      throw new Error(
        `declared fingerprint part '${part}' is identified by ${matches.length} probe keys` +
          ` (${matches.join(', ') || 'none'}): give it exactly one`
      )
    }
    return { part, key: matches[0] }
  })
  for (const key of keys) {
    const bound = bindings.filter(binding => binding.key === key)
    if (bound.length !== 1) {
      throw new Error(
        `probe key '${key}' binds ${bound.length} declared parts: ` +
          `it must identify exactly one of (${parts.join(' | ')})`
      )
    }
  }
  return bindings
}
