import type { Database } from 'bun:sqlite'
import { getDb } from '../db/container'
import {
  createPreviewToken as dbCreatePreviewToken,
  consumePreviewToken as dbConsumePreviewToken,
  isPreviewTokenExpired
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

/**
 * Claim AND validate a confirm token in one step.
 *
 * The token row is deleted first (`DELETE ... RETURNING`), then the claimed
 * row is checked against the action it is being used for. Two concurrent
 * confirms therefore cannot both pass: only one of them receives a row, the
 * other reads as `not_found` and is refused. Verification can no longer be
 * separated from the claim — a read-only check followed by a later consume
 * lets a second caller win the same mutation.
 *
 * A rejected claim burns the token (fail closed, so a stale or misdirected
 * token cannot be replayed); the caller must re-preview to get a fresh one.
 */
export function consumePreviewTokenService(
  token: string,
  kind: string,
  targetId: string,
  currentFingerprint: string,
  d: Database = getDb(),
): VerifyPreviewTokenResult {
  const row = dbConsumePreviewToken(d, token)
  if (!row) return { valid: false, reason: 'not_found' }
  if (row.kind !== kind) return { valid: false, reason: 'kind_mismatch' }
  if (row.target_id !== targetId) return { valid: false, reason: 'target_mismatch' }
  if (isPreviewTokenExpired(row.expires_at)) return { valid: false, reason: 'expired' }
  if (row.fingerprint !== currentFingerprint) return { valid: false, reason: 'stale' }
  return { valid: true }
}
