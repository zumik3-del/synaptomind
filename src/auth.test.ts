import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { hashUserToken } from './config'
import { checkBearerAuth, getValidTokens, resolveUser } from './auth'
import type { UserRef } from './auth'
import { configFixture } from './test/helpers'

const SECRET = 'secret-a'
const USER_TOKEN = 'user-token-alice'

const singleUser = configFixture({ users: [] })
const withAlice = configFixture({
  users: [{ id: 'alice', dbPath: '/tmp/alice.db', tokenSha256: hashUserToken(USER_TOKEN) }]
})

afterAll(() => {
  delete process.env.SYNAPTOMIND_SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_USER_TOKEN_ALICE
})

beforeEach(() => {
  process.env.SYNAPTOMIND_SECRET = SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_USER_TOKEN_ALICE
})

describe('checkBearerAuth', () => {
  test("accepts 'Bearer <secret>'", () => {
    expect(checkBearerAuth('Bearer secret-a', singleUser)).toBe(true)
  })

  test("rejects 'Bearer wrong'", () => {
    expect(checkBearerAuth('Bearer wrong', singleUser)).toBe(false)
  })

  test('rejects a bare token without the Bearer prefix', () => {
    expect(checkBearerAuth('secret-a', singleUser)).toBe(false)
  })

  test('rejects a missing Authorization header', () => {
    expect(checkBearerAuth(undefined, singleUser)).toBe(false)
  })

  test('getValidTokens exposes only the secret in single-user mode', () => {
    const tokens = getValidTokens(singleUser)
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(t => t === SECRET)).toBeTrue()
  })

  test('SYNAPTOMIND_SERVICE_TOKEN is ignored (service token removed)', () => {
    process.env.SYNAPTOMIND_SERVICE_TOKEN = 'secret-b'
    const tokens = getValidTokens(singleUser)
    expect(tokens.every(t => t === SECRET)).toBeTrue()
    expect(checkBearerAuth('Bearer secret-b', singleUser)).toBe(false)
  })
})

describe('resolveUser', () => {
  test('returns a UserRef for a valid secret', () => {
    const ref: UserRef | null = resolveUser('Bearer secret-a', singleUser)
    expect(ref).not.toBeNull()
    expect(ref!.userId).toBe('legacy')
    expect(ref!.kind).toBe('legacy')
  })

  test('returns null for a wrong token', () => {
    expect(resolveUser('Bearer wrong', singleUser)).toBeNull()
  })

  test('returns null for a bare token without the Bearer prefix', () => {
    expect(resolveUser('secret-a', singleUser)).toBeNull()
  })

  test('returns null for a missing Authorization header', () => {
    expect(resolveUser(undefined, singleUser)).toBeNull()
  })

  test('checkBearerAuth delegates to resolveUser', () => {
    for (const auth of ['Bearer secret-a', 'Bearer wrong', 'secret-a', undefined]) {
      expect(checkBearerAuth(auth, singleUser)).toBe(resolveUser(auth, singleUser) !== null)
    }
  })
})

describe('SYNAPTOMIND_SECRET inert when users configured', () => {
  beforeEach(() => {
    process.env.SYNAPTOMIND_SECRET = SECRET
  })

  test('getValidTokens returns empty', () => {
    expect(getValidTokens(withAlice)).toEqual([])
  })

  test('SYNAPTOMIND_SECRET is not accepted', () => {
    expect(checkBearerAuth('Bearer secret-a', withAlice)).toBe(false)
    expect(resolveUser('Bearer secret-a', withAlice)).toBeNull()
  })

  test('configured user token resolves to a UserRef', () => {
    const ref = resolveUser(`Bearer ${USER_TOKEN}`, withAlice)
    expect(ref).not.toBeNull()
    expect(ref!.userId).toBe('alice')
    expect(ref!.kind).toBe('user')
  })

  test('unknown token is rejected', () => {
    expect(resolveUser('Bearer nope', withAlice)).toBeNull()
    expect(checkBearerAuth('Bearer nope', withAlice)).toBe(false)
  })

  test('SYNAPTOMIND_SERVICE_TOKEN env is ignored', () => {
    process.env.SYNAPTOMIND_SERVICE_TOKEN = 'secret-b'
    expect(checkBearerAuth('Bearer secret-b', withAlice)).toBe(false)
    expect(resolveUser('Bearer secret-b', withAlice)).toBeNull()
    delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  })
})
