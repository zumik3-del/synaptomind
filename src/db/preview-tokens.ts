import type { Database } from 'bun:sqlite'

export interface PreviewTokenRow {
  token: string
  kind: string
  target_id: string
  fingerprint: string
  created_at: string
  expires_at: string
}

const DEFAULT_TTL_MINUTES = 5

export function createPreviewToken(
  db: Database,
  kind: string,
  targetId: string,
  fingerprint: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): string {
  const token = Bun.randomUUIDv7()
  const now = new Date()
  const expires = new Date(now.getTime() + ttlMinutes * 60 * 1000)
  db.prepare(
    `INSERT INTO preview_tokens (token, kind, target_id, fingerprint, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(token, kind, targetId, fingerprint, now.toISOString(), expires.toISOString())
  return token
}

export function getPreviewToken(db: Database, token: string): PreviewTokenRow | undefined {
  const row = db.prepare(`SELECT * FROM preview_tokens WHERE token = ?`).get(token) as PreviewTokenRow | undefined | null
  return row ?? undefined
}

/**
 * Atomically claim a token: the row is deleted in the same statement that
 * returns it, so of two concurrent confirms only the one whose DELETE matched
 * gets a row — the other gets `undefined` and must be refused.
 */
export function consumePreviewToken(db: Database, token: string): PreviewTokenRow | undefined {
  const row = db.prepare(`DELETE FROM preview_tokens WHERE token = ? RETURNING *`).get(token) as PreviewTokenRow | undefined | null
  return row ?? undefined
}

export function deleteExpiredPreviewTokens(db: Database, now: string = new Date().toISOString()): number {
  const res = db.prepare(`DELETE FROM preview_tokens WHERE expires_at < ?`).run(now)
  return res.changes
}

export function isPreviewTokenExpired(expiresAt: string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() < now.getTime()
}
