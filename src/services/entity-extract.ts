export type EntityType = 'code' | 'tag' | 'wiki' | 'term'

const BACKTICK_RE = /`([^`]+)`/g
const CAMEL_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g
const SNAKE_RE = /\b([a-z]+(?:_[a-z0-9]+)+)\b/g
const TAG_RE = /\B#([a-zA-Z][a-zA-Z0-9_-]*)/g
const CODEBLOCK_LANG_RE = /```(\w+)/g
const MAX_ENTITY_LEN = 100

function normalizeEntity(raw: string): string {
  return raw.trim().toLowerCase().slice(0, MAX_ENTITY_LEN)
}

export function extractEntities(content: string): Array<{ name: string; type: EntityType }> {
  const seen = new Map<string, EntityType>()

  const add = (name: string, type: EntityType): void => {
    const normalized = normalizeEntity(name)
    if (!normalized || normalized.length < 2) return
    const priority: Record<EntityType, number> = { code: 3, tag: 2, wiki: 1, term: 0 }
    const existing = seen.get(normalized)
    if (!existing || priority[type] > priority[existing]) {
      seen.set(normalized, type)
    }
  }

  BACKTICK_RE.lastIndex = 0
  let match = BACKTICK_RE.exec(content)
  while (match) { add(match[1], 'code'); match = BACKTICK_RE.exec(content) }

  CAMEL_RE.lastIndex = 0
  match = CAMEL_RE.exec(content)
  while (match) { add(match[1], 'code'); match = CAMEL_RE.exec(content) }

  SNAKE_RE.lastIndex = 0
  match = SNAKE_RE.exec(content)
  while (match) { add(match[1], 'code'); match = SNAKE_RE.exec(content) }

  TAG_RE.lastIndex = 0
  match = TAG_RE.exec(content)
  while (match) { add(match[1], 'tag'); match = TAG_RE.exec(content) }

  CODEBLOCK_LANG_RE.lastIndex = 0
  match = CODEBLOCK_LANG_RE.exec(content)
  while (match) { add(match[1], 'code'); match = CODEBLOCK_LANG_RE.exec(content) }

  return [...seen.entries()].map(([name, type]) => ({ name, type }))
}
