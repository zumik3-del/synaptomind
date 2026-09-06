import { afterAll, describe, expect, test } from 'bun:test'
import { checkBearerAuth, getValidTokens, resetValidTokens } from './auth'

const SECRET = 'secret-a'

afterAll(() => {
  delete process.env.SYNAPTOMIND_SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  resetValidTokens()
})

function primeEnv(secret: string, serviceToken?: string): void {
  process.env.SYNAPTOMIND_SECRET = secret
  if (serviceToken === undefined) {
    delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  } else {
    process.env.SYNAPTOMIND_SERVICE_TOKEN = serviceToken
  }
  // the token list is cached at module level and other test files may have
  // warmed it — drop it so the env set above is re-read
  resetValidTokens()
}

describe('checkBearerAuth', () => {
  test("accepts 'Bearer <secret>'", () => {
    primeEnv(SECRET)
    expect(checkBearerAuth('Bearer secret-a')).toBe(true)
  })

  test("rejects 'Bearer wrong'", () => {
    primeEnv(SECRET)
    expect(checkBearerAuth('Bearer wrong')).toBe(false)
  })

  test('rejects a bare token without the Bearer prefix', () => {
    primeEnv(SECRET)
    expect(checkBearerAuth('secret-a')).toBe(false)
  })

  test('rejects a missing Authorization header', () => {
    primeEnv(SECRET)
    expect(checkBearerAuth(undefined)).toBe(false)
  })

  test('getValidTokens exposes only the secret when SERVICE_TOKEN is unset', () => {
    primeEnv(SECRET)
    const tokens = getValidTokens()
    expect(tokens.length).toBeGreaterThan(0)
    // every cached token is the configured secret (impl may repeat it)
    expect(tokens.every(t => t === SECRET)).toBeTrue()
  })
})

describe('checkBearerAuth with SYNAPTOMIND_SERVICE_TOKEN', () => {
  test('getValidTokens lists secret and service token', () => {
    primeEnv(SECRET, 'secret-b')
    expect(getValidTokens()).toEqual(['secret-a', 'secret-b'])
  })

  test("accepts 'Bearer <service token>'", () => {
    primeEnv(SECRET, 'secret-b')
    expect(checkBearerAuth('Bearer secret-b')).toBe(true)
  })

  test('still accepts the primary secret', () => {
    primeEnv(SECRET, 'secret-b')
    expect(checkBearerAuth('Bearer secret-a')).toBe(true)
  })
})
