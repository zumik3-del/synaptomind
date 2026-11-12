import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import { createPreviewTokenService, consumePreviewTokenService } from './preview-tokens.service'

/**
 * The one destructive-confirm protocol (audit F1).
 *
 * A preview mints a short-lived token bound to the state a mutation depends on;
 * a confirm must claim that token in the same step that compares the current
 * state, so a second caller cannot win the same mutation and a stale preview
 * cannot be replayed. Generalized from the repair gate
 * (`health-check-repair.service.ts`), which was the only implementation living
 * in the service layer while every tool re-implemented the handshake.
 */

/** One value a fingerprint is built from; arrays fold in place, `null`/`undefined` render empty. */
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
  // Strings are quoted so a separator inside one cannot pass for a boundary.
  return typeof part === 'string' ? JSON.stringify(part) : String(part)
}

/**
 * Fold the values a confirm must still see into one token fingerprint.
 *
 * The caller orders the parts (identity first, then the state that has to hold
 * when the confirm arrives). Only preview/confirm agreement matters: a token is
 * minted and claimed by the same build, so the shape is not a wire format.
 */
export function fingerprintOf(...parts: readonly FingerprintPart[]): string {
  return parts.map(fingerprintPart).join('|')
}

/** The confirm half of a request: the two arguments every gated action consumes. */
export interface GateRequest {
  /** `true` executes; false, omitted or anything else previews. */
  confirm?: unknown
  /** The token a preview returned; required to execute. */
  preview_token?: unknown
}

/** What one guarded call guards, and what it does. */
export interface GuardedRun<Preview, Result> {
  /** Token scope: the action name (`unlink`, `apply`, ...) it is claimed under. */
  kind: string
  /** Token scope: the object the confirm is bound to (an id, a joined batch, `global`). */
  targetId: string
  /** State fingerprint, or `null` when the guarded object is already gone. */
  fingerprint: () => string | null
  /** The non-mutating answer; `token` is `null` when there is nothing to confirm. */
  preview: (token: string | null) => Preview | Promise<Preview>
  /** The mutation; runs only after the confirm claim succeeded. */
  apply: () => Result | Promise<Result>
}

export type GuardedOutcome<Preview, Result> =
  | { status: 'preview'; token: string | null; value: Preview }
  | { status: 'executed'; value: Result }

/**
 * Run one preview-or-confirm call through the gate.
 *
 * Not a confirm: mint the token for the state read at the start of the call and
 * answer the caller's preview payload. A vanished target (`fingerprint` is
 * `null`) mints nothing — there is nothing left to guard — and the confirm path
 * then runs `apply` unguarded, so the mutation's own not-found answer stands
 * instead of a token error.
 *
 * `confirm: true`: claim and compare the token in one step, refusing a missing,
 * expired, misdirected or stale one with a single typed `ValidationError`.
 */
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
