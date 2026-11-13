import { createHash } from 'node:crypto'

export const MS_PER_DAY = 86_400_000

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

// The hashing format is baked into stored `content_hash` values and the v033/v046 backfills, so a
// change here silently breaks dedupe for existing rows.
export function computeContentHash(content: string, projectId: string): string {
  return createHash('sha256')
    .update(content + projectId)
    .digest('hex')
}

export function parseTags(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw.map(t => t.trim()).filter(Boolean)
  const parsed = raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : undefined
}
