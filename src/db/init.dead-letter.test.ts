import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { getDb } from './container'
import { closeDb, initDb } from './init'
import { seedThought } from '../test/helpers'

// The dead-letter row must survive a close/re-open cycle, so this file uses a
// file-backed DB (a fresh :memory: DB would be empty after every initDb).
const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-dead-letter-'))
const dbPath = join(tmpRoot, 'test.db')

afterAll(() => {
  // restore the default so later test files are unaffected
  config.embedder.resetDeadLetters = false
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function seedDeadLetter(): string {
  // the insert trigger queues the thought; turn it into a dead letter
  const id = seedThought({ content: 'poison' })
  getDb()
    .prepare('UPDATE pending_embeddings SET is_error = 1, attempts = 10, error = ? WHERE thought_id = ?')
    .run('boom', id)
  return id
}

function deadLetterRow(id: string): { is_error: number; error: string | null } {
  return getDb()
    .prepare('SELECT is_error, error FROM pending_embeddings WHERE thought_id = ?')
    .get(id) as { is_error: number; error: string | null }
}

test('dead letters are NOT reset on boot by default (#113)', () => {
  config.embedder.resetDeadLetters = false
  initDb({ dbPath, runMigrations: true })
  const id = seedDeadLetter()

  closeDb()
  initDb({ dbPath, runMigrations: true })

  // a poisonous thought must not get MAX_ATTEMPTS fresh tries on every restart
  const row = deadLetterRow(id)
  expect(row.is_error).toBe(1)
  expect(row.error).toBe('boom')
})

test('dead letters ARE reset when resetDeadLetters is enabled', () => {
  config.embedder.resetDeadLetters = true
  initDb({ dbPath, runMigrations: true })
  const id = seedDeadLetter()

  closeDb()
  initDb({ dbPath, runMigrations: true })

  const row = deadLetterRow(id)
  expect(row.is_error).toBe(0)
  expect(row.error).toBeNull()
})
