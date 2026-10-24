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

export function deletePreviewToken(db: Database, token: string): boolean {
  const res = db.prepare(`DELETE FROM preview_tokens WHERE token = ?`).run(token)
  return res.changes > 0
}

export function isPreviewTokenExpired(expiresAt: string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() < now.getTime()
}
