import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import { createPreviewTokenService, consumePreviewTokenService } from './preview-tokens.service'

export type FingerprintPart =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly FingerprintPart[]

function fingerprintPart(part: FingerprintPart): string {
  if (Array.isArray(part)) return part.map(fingerprintPart).join(',')
  if (part === null || part === undefined) return ''
  return typeof part === 'string' ? JSON.stringify(part) : String(part)
}

export function fingerprintOf(...parts: readonly FingerprintPart[]): string {
  return parts.map(fingerprintPart).join('|')
}

export interface GateRequest {
  confirm?: unknown
  preview_token?: unknown
}

export interface GuardedRun<Preview, Result> {
  kind: string
  targetId: string
  fingerprint: () => string | null
  preview: (token: string | null) => Preview | Promise<Preview>
  apply: () => Result | Promise<Result>
}

export type GuardedOutcome<Preview, Result> =
  | { status: 'preview'; token: string | null; value: Preview }
  | { status: 'executed'; value: Result }

export async function runGuarded<Preview, Result>(
  request: GateRequest,
  run: GuardedRun<Preview, Result>,
  d: Database = getDb()
): Promise<GuardedOutcome<Preview, Result>> {
  const fingerprint = run.fingerprint()

  if (request.confirm !== true) {
    const token =
      fingerprint === null
        ? null
        : createPreviewTokenService(run.kind, run.targetId, fingerprint, d)
    return { status: 'preview', token, value: await run.preview(token) }
  }

  const token = typeof request.preview_token === 'string' ? request.preview_token : undefined
  if (fingerprint !== null) {
    if (!token) throw new ValidationError('preview_token is required')
    const verification = consumePreviewTokenService(token, run.kind, run.targetId, fingerprint, d)
    if (!verification.valid)
      throw new ValidationError(`preview token ${verification.reason ?? 'invalid'}`)
  }
  return { status: 'executed', value: await run.apply() }
}
