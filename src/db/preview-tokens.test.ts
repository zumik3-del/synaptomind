import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import {
  createPreviewToken,
  getPreviewToken,
  deletePreviewToken,
  consumePreviewToken,
  deleteExpiredPreviewTokens,
  isPreviewTokenExpired,
} from './preview-tokens'
import {
  createPreviewTokenService,
  verifyPreviewTokenService,
  consumePreviewTokenService,
} from '../services/preview-tokens.service'

beforeEach(createTestDb)
afterEach(closeDb)

test('consume is atomic: second delete returns false', () => {
  const db = getDb()
  const token = createPreviewToken(db, 'kind', 'target', 'fp')
  expect(deletePreviewToken(db, token)).toBeTrue()
  expect(deletePreviewToken(db, token)).toBeFalse()
  expect(getPreviewToken(db, token)).toBeUndefined()
})

test('consumePreviewToken returns row once then undefined', () => {
  const db = getDb()
  const token = createPreviewToken(db, 'kind', 'target', 'fp')
  const row = consumePreviewToken(db, token)
  expect(row?.token).toBe(token)
  expect(consumePreviewToken(db, token)).toBeUndefined()
})

test('expired tokens are swept', () => {
  const db = getDb()
  const token = createPreviewToken(db, 'kind', 'target', 'fp', 0)
  const future = new Date(Date.now() + 1000).toISOString()
  const swept = deleteExpiredPreviewTokens(db, future)
  expect(swept).toBeGreaterThanOrEqual(1)
  expect(getPreviewToken(db, token)).toBeUndefined()
})

test('isPreviewTokenExpired reflects expires_at', () => {
  const past = new Date(Date.now() - 1000).toISOString()
  expect(isPreviewTokenExpired(past)).toBeTrue()
})

test('preview token consume is atomic: no double-confirm', () => {
  const db = getDb()
  const token = createPreviewTokenService('kind', 'target', 'fp', db)
  expect(verifyPreviewTokenService(token, 'kind', 'target', 'fp', db).valid).toBeTrue()
  expect(consumePreviewTokenService(token, db)).toBeTrue()
  // Second confirm: token is gone -> not_found, and consume returns false.
  expect(verifyPreviewTokenService(token, 'kind', 'target', 'fp', db).valid).toBeFalse()
  expect(verifyPreviewTokenService(token, 'kind', 'target', 'fp', db).reason).toBe('not_found')
  expect(consumePreviewTokenService(token, db)).toBeFalse()
})

test('preview token consume returns the row only once', () => {
  const db = getDb()
  const token = createPreviewToken(db, 'kind', 'target', 'fp')
  const row = consumePreviewToken(db, token)
  expect(row?.token).toBe(token)
  expect(consumePreviewToken(db, token)).toBeUndefined()
  expect(getPreviewToken(db, token)).toBeUndefined()
})
