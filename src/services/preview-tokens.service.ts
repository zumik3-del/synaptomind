import type { Database } from 'bun:sqlite'
import { getDb } from '../db/container'
import {
  createPreviewToken as dbCreatePreviewToken,
  getPreviewToken as dbGetPreviewToken,
  deletePreviewToken as dbDeletePreviewToken,
  isPreviewTokenExpired,
  type PreviewTokenRow
} from '../db/preview-tokens'

const PREVIEW_TOKEN_TTL_MINUTES = 5

export function createPreviewTokenService(
  kind: string,
  targetId: string,
  fingerprint: string,
  d: Database = getDb(),
): string {
  return dbCreatePreviewToken(d, kind, targetId, fingerprint, PREVIEW_TOKEN_TTL_MINUTES)
}

export interface VerifyPreviewTokenResult {
  valid: boolean
  reason?: 'not_found' | 'kind_mismatch' | 'target_mismatch' | 'expired' | 'stale'
}

export function verifyPreviewTokenService(
  token: string,
  kind: string,
  targetId: string,
  currentFingerprint: string,
  d: Database = getDb(),
): VerifyPreviewTokenResult {
  const row: PreviewTokenRow | undefined = dbGetPreviewToken(d, token)
  if (!row) return { valid: false, reason: 'not_found' }
  if (row.kind !== kind) return { valid: false, reason: 'kind_mismatch' }
  if (row.target_id !== targetId) return { valid: false, reason: 'target_mismatch' }
  if (isPreviewTokenExpired(row.expires_at)) return { valid: false, reason: 'expired' }
  if (row.fingerprint !== currentFingerprint) return { valid: false, reason: 'stale' }
  return { valid: true }
}

export function consumePreviewTokenService(token: string, d: Database = getDb()): boolean {
  return dbDeletePreviewToken(d, token)
}
