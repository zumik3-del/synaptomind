import { afterAll, beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { config, hashUserToken } from './config'
import { checkBearerAuth, getValidTokens, resolveUser } from './auth'
import type { UserRef } from './auth'

const SECRET = 'secret-a'
const USER_TOKEN = 'user-token-alice'

const originalUsers = config.users

afterAll(() => {
  config.users = originalUsers
  delete process.env.SYNAPTOMIND_SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_USER_TOKEN_ALICE
})

beforeEach(() => {
  config.users = []
  process.env.SYNAPTOMIND_SECRET = SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_USER_TOKEN_ALICE
})

afterEach(() => {
  config.users = []
})

describe('checkBearerAuth', () => {
  test("accepts 'Bearer <secret>'", () => {
    expect(checkBearerAuth('Bearer secret-a')).toBe(true)
  })

  test("rejects 'Bearer wrong'", () => {
    expect(checkBearerAuth('Bearer wrong')).toBe(false)
  })

  test('rejects a bare token without the Bearer prefix', () => {
    expect(checkBearerAuth('secret-a')).toBe(false)
  })

  test('rejects a missing Authorization header', () => {
    expect(checkBearerAuth(undefined)).toBe(false)
  })

  test('getValidTokens exposes only the secret in single-user mode', () => {
    const tokens = getValidTokens()
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(t => t === SECRET)).toBeTrue()
  })

  test('SYNAPTOMIND_SERVICE_TOKEN is ignored (service token removed)', () => {
    process.env.SYNAPTOMIND_SERVICE_TOKEN = 'secret-b'
    const tokens = getValidTokens()
    expect(tokens.every(t => t === SECRET)).toBeTrue()
    expect(checkBearerAuth('Bearer secret-b')).toBe(false)
  })
})

describe('resolveUser', () => {
  test('returns a UserRef for a valid secret', () => {
    const ref: UserRef | null = resolveUser('Bearer secret-a')
    expect(ref).not.toBeNull()
    expect(ref!.userId).toBe('legacy')
    expect(ref!.kind).toBe('legacy')
  })

  test('returns null for a wrong token', () => {
    expect(resolveUser('Bearer wrong')).toBeNull()
  })

  test('returns null for a bare token without the Bearer prefix', () => {
    expect(resolveUser('secret-a')).toBeNull()
  })

  test('returns null for a missing Authorization header', () => {
    expect(resolveUser(undefined)).toBeNull()
  })

  test('checkBearerAuth delegates to resolveUser', () => {
    for (const auth of ['Bearer secret-a', 'Bearer wrong', 'secret-a', undefined]) {
      expect(checkBearerAuth(auth)).toBe(resolveUser(auth) !== null)
    }
  })
})

describe('SYNAPTOMIND_SECRET inert when users configured', () => {
  beforeEach(() => {
    process.env.SYNAPTOMIND_SECRET = SECRET
    config.users = [
      { id: 'alice', dbPath: '/tmp/alice.db', tokenSha256: hashUserToken(USER_TOKEN) }
    ]
  })

  test('getValidTokens returns empty', () => {
    expect(getValidTokens()).toEqual([])
  })

  test('SYNAPTOMIND_SECRET is not accepted', () => {
    expect(checkBearerAuth('Bearer secret-a')).toBe(false)
    expect(resolveUser('Bearer secret-a')).toBeNull()
  })

  test('configured user token resolves to a UserRef', () => {
    const ref = resolveUser(`Bearer ${USER_TOKEN}`)
    expect(ref).not.toBeNull()
    expect(ref!.userId).toBe('alice')
    expect(ref!.kind).toBe('user')
  })

  test('unknown token is rejected', () => {
    expect(resolveUser('Bearer nope')).toBeNull()
    expect(checkBearerAuth('Bearer nope')).toBe(false)
  })

  test('SYNAPTOMIND_SERVICE_TOKEN env is ignored', () => {
    process.env.SYNAPTOMIND_SERVICE_TOKEN = 'secret-b'
    expect(checkBearerAuth('Bearer secret-b')).toBe(false)
    expect(resolveUser('Bearer secret-b')).toBeNull()
    delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  })
})
