import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { ValidationError } from '../errors'
import { createTestDb } from '../test/helpers'
import { fingerprintOf, type GuardedRun, runGuarded } from './confirm-gate.service'

beforeEach(createTestDb)
afterEach(closeDb)

function guarded(overrides: Partial<GuardedRun<string, string>> = {}) {
  const calls = { preview: 0, apply: 0 }
  const run: GuardedRun<string, string> = {
    kind: 'unlink',
    targetId: 'edge-1',
    fingerprint: () => fingerprintOf('edge-1', 'active'),
    preview: token => {
      calls.preview += 1
      return `preview:${token}`
    },
    apply: () => {
      calls.apply += 1
      return 'applied'
    },
    ...overrides
  }
  return { run, calls }
}

function tokenRow(token: string) {
  const row = getDb()
    .prepare('SELECT kind, target_id, fingerprint FROM preview_tokens WHERE token = ?')
    .get(token) as { kind: string; target_id: string; fingerprint: string } | null | undefined
  return row ?? undefined
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    error => error
  )
}

describe('runGuarded preview half', () => {
  test('confirm omitted, false or non-boolean previews and never applies', async () => {
    for (const request of [{}, { confirm: false }, { confirm: 'yes' }, { confirm: 1 }]) {
      const { run, calls } = guarded()
      const outcome = await runGuarded(request, run)

      expect(outcome.status).toBe('preview')
      if (outcome.status !== 'preview') throw new Error('unreachable')
      expect(typeof outcome.token).toBe('string')
      expect(outcome.value).toBe(`preview:${outcome.token}`)
      expect(tokenRow(outcome.token as string)).toEqual({
        kind: 'unlink',
        target_id: 'edge-1',
        fingerprint: fingerprintOf('edge-1', 'active')
      })
      expect(calls).toEqual({ preview: 1, apply: 0 })
    }
  })

  test('a vanished target previews without a token', async () => {
    const { run, calls } = guarded({ fingerprint: () => null })

    const outcome = await runGuarded({}, run)

    expect(outcome).toEqual({ status: 'preview', token: null, value: 'preview:null' })
    expect(calls).toEqual({ preview: 1, apply: 0 })
    expect(
      (getDb().prepare('SELECT COUNT(*) AS n FROM preview_tokens').get() as { n: number }).n
    ).toBe(0)
  })
})

describe('runGuarded confirm half', () => {
  test('the preview token executes the mutation exactly once', async () => {
    const { run, calls } = guarded()
    const preview = await runGuarded({}, run)
    if (preview.status !== 'preview') throw new Error('expected a preview')

    const executed = await runGuarded({ confirm: true, preview_token: preview.token }, run)

    expect(executed).toEqual({ status: 'executed', value: 'applied' })
    expect(calls).toEqual({ preview: 1, apply: 1 })
    expect(tokenRow(preview.token as string)).toBeUndefined()
  })

  test('a token is single-use: the same confirm replayed is refused', async () => {
    const { run, calls } = guarded()
    const preview = await runGuarded({}, run)
    if (preview.status !== 'preview') throw new Error('expected a preview')

    await runGuarded({ confirm: true, preview_token: preview.token }, run)
    const replay = await failureOf(runGuarded({ confirm: true, preview_token: preview.token }, run))

    expect(replay).toBeInstanceOf(ValidationError)
    expect((replay as Error).message).toBe('preview token not_found')
    expect(calls.apply).toBe(1)
  })

  test('two concurrent confirms: exactly one wins and mutates', async () => {
    const { run, calls } = guarded()
    const preview = await runGuarded({}, run)
    if (preview.status !== 'preview') throw new Error('expected a preview')

    const results = await Promise.allSettled([
      runGuarded({ confirm: true, preview_token: preview.token }, run),
      runGuarded({ confirm: true, preview_token: preview.token }, run)
    ])

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.filter(r => r.status === 'rejected')
    expect(refused).toHaveLength(1)
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError)
    expect((refused[0] as PromiseRejectedResult).reason.message).toBe('preview token not_found')
    expect(calls.apply).toBe(1)
  })

  test.each([undefined, 42, { token: 'x' }])(
    'a missing or non-string token is refused before apply (%p)',
    async previewToken => {
      const { run, calls } = guarded()

      const failure = await failureOf(
        runGuarded({ confirm: true, preview_token: previewToken }, run)
      )

      expect(failure).toBeInstanceOf(ValidationError)
      expect((failure as Error).message).toBe('preview_token is required')
      expect(calls.apply).toBe(0)
    }
  )

  test('a null fingerprint confirms unguarded, so the domain answer stands', async () => {
    const { run, calls } = guarded({ fingerprint: () => null })

    const executed = await runGuarded(
      { confirm: true, preview_token: 'ignored-because-nothing-is-guarded' },
      run
    )

    expect(executed).toEqual({ status: 'executed', value: 'applied' })
    expect(calls.apply).toBe(1)
  })

  test('a target that vanished after its preview confirms unguarded and keeps the old token', async () => {
    const { run, calls } = guarded()
    const preview = await runGuarded({}, run)
    if (preview.status !== 'preview') throw new Error('expected a preview')

    const vanished = { ...run, fingerprint: () => null }
    const executed = await runGuarded({ confirm: true, preview_token: preview.token }, vanished)

    expect(executed).toEqual({ status: 'executed', value: 'applied' })
    expect(calls.apply).toBe(1)
    expect(tokenRow(preview.token as string)).toBeDefined()
  })
})

describe('runGuarded token refusals', () => {
  test('drifted state refuses the token as stale and burns it', async () => {
    const { run, calls } = guarded()
    const preview = await runGuarded({}, run)
    if (preview.status !== 'preview') throw new Error('expected a preview')

    const drifted = { ...run, fingerprint: () => fingerprintOf('edge-1', 'archived') }
    const stale = await failureOf(
      runGuarded({ confirm: true, preview_token: preview.token }, drifted)
    )

    expect(stale).toBeInstanceOf(ValidationError)
    expect((stale as Error).message).toBe('preview token stale')
    expect(calls.apply).toBe(0)
    const replay = await failureOf(runGuarded({ confirm: true, preview_token: preview.token }, run))
    expect((replay as Error).message).toBe('preview token not_found')
    expect(calls.apply).toBe(0)
  })

  test('an expired token is refused', async () => {
    const { run, calls } = guarded()
    const preview = await runGuarded({}, run)
    if (preview.status !== 'preview') throw new Error('expected a preview')
    getDb()
      .prepare("UPDATE preview_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?")
      .run(preview.token as string)

    const failure = await failureOf(
      runGuarded({ confirm: true, preview_token: preview.token }, run)
    )

    expect((failure as Error).message).toBe('preview token expired')
    expect(calls.apply).toBe(0)
  })

  test('a token minted for another action or another target is refused', async () => {
    const kindRun = guarded()
    const kindPreview = await runGuarded({}, kindRun.run)
    if (kindPreview.status !== 'preview') throw new Error('expected a preview')
    const wrongKind = await failureOf(
      runGuarded(
        { confirm: true, preview_token: kindPreview.token },
        { ...kindRun.run, kind: 'retype' }
      )
    )
    expect((wrongKind as Error).message).toBe('preview token kind_mismatch')
    expect(kindRun.calls.apply).toBe(0)

    const targetRun = guarded()
    const targetPreview = await runGuarded({}, targetRun.run)
    if (targetPreview.status !== 'preview') throw new Error('expected a preview')
    const wrongTarget = await failureOf(
      runGuarded(
        { confirm: true, preview_token: targetPreview.token },
        { ...targetRun.run, targetId: 'edge-2' }
      )
    )
    expect((wrongTarget as Error).message).toBe('preview token target_mismatch')
    expect(targetRun.calls.apply).toBe(0)
  })
})

describe('fingerprintOf', () => {
  test('quotes strings so a separator inside a value cannot forge a boundary', () => {
    expect(fingerprintOf('a|b', 'c')).not.toBe(fingerprintOf('a', 'b|c'))
    expect(fingerprintOf('a', 'b')).toBe(fingerprintOf('a', 'b'))
  })

  test('renders numbers and booleans plainly, null/undefined empty, arrays folded', () => {
    expect(fingerprintOf(1, true)).toBe('1|true')
    expect(fingerprintOf(null, undefined)).toBe('|')
    expect(fingerprintOf(['a', 'b'], 'c')).toBe('"a","b"|"c"')
  })

  test('an empty fold is stable, so a token round-trips', () => {
    expect(fingerprintOf()).toBe('')
    expect(fingerprintOf([])).toBe('')
  })
})
