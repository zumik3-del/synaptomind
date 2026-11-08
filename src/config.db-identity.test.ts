import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFreshConfig } from './test/fresh-config'

let root = ''
const secret = 'sensitive database contents'
const hashes = ['a'.repeat(64), 'b'.repeat(64)]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'synaptomind-db-identity-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function load(paths: string[]) {
  return loadFreshConfig({
    env: { SYNAPTOMIND_USER_TOKEN_ALICE: undefined, SYNAPTOMIND_USER_TOKEN_BOB: undefined },
    configFile: {
      users: paths.map((dbPath, i) => ({ id: ['alice', 'bob'][i], dbPath, tokenSha256: hashes[i] }))
    }
  })
}

describe('user database filesystem identities', () => {
  test('rejects normalized aliases for a missing file before creating it', async () => {
    const target = join(root, 'missing.db')
    const result = await load([target, `${root}/absent/../missing.db`])
    expect(result.error).toContain('duplicate user dbPath')
    expect(existsSync(target)).toBe(false)
  })

  test('rejects a symlinked parent alias for a missing file', async () => {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    const target = join(root, 'real', 'new.db')
    const result = await load([target, join(root, 'alias', 'new.db')])
    expect(result.error).toContain('duplicate user dbPath')
    expect(existsSync(target)).toBe(false)
  })

  test('rejects an existing file symlink alias', async () => {
    const target = join(root, 'real.db')
    writeFileSync(target, secret)
    symlinkSync(target, join(root, 'alias.db'))
    const result = await load([target, join(root, 'alias.db')])
    expect(result.error).toContain('duplicate user dbPath')
    expect(readFileSync(target, 'utf8')).toBe(secret)
  })

  test('resolves symlink before subsequent parent component', async () => {
    mkdirSync(join(root, 'real', 'child'), { recursive: true })
    symlinkSync(join(root, 'real', 'child'), join(root, 'alias'))
    const result = await load([join(root, 'real', 'new.db'), `${root}/alias/../new.db`])
    expect(result.error).toContain('duplicate user dbPath')
  })

  test('rejects existing hard links without disclosing secrets or changing contents', async () => {
    const target = join(root, 'one.db')
    const alias = join(root, 'two.db')
    writeFileSync(target, secret)
    linkSync(target, alias)
    const result = await load([target, alias])
    expect(result.error).toContain('duplicate user dbPath')
    expect(`${result.error} ${result.stderr}`).not.toContain(secret)
    expect(`${result.error} ${result.stderr}`).not.toContain(hashes[0])
    expect(`${result.error} ${result.stderr}`).not.toContain(hashes[1])
    expect(readFileSync(target, 'utf8')).toBe(secret)
  })

  test('rejects a dangling symlink rather than treating it as a missing file', async () => {
    symlinkSync(join(root, 'missing'), join(root, 'dangling'))
    const result = await load([join(root, 'one.db'), join(root, 'dangling', 'two.db')])
    expect(result.error).toContain('cannot safely resolve user dbPath')
  })

  test('fails closed when a path traverses a non-directory', async () => {
    writeFileSync(join(root, 'file'), secret)
    const result = await load([join(root, 'one.db'), join(root, 'file', 'two.db')])
    expect(result.error).toContain('cannot safely resolve user dbPath')
  })

  test('accepts distinct databases and permits legacy db.path to match a user', async () => {
    const one = join(root, 'one.db')
    const two = join(root, 'two.db')
    const result = await loadFreshConfig({
      env: { SYNAPTOMIND_USER_TOKEN_ALICE: undefined, SYNAPTOMIND_USER_TOKEN_BOB: undefined },
      configFile: {
        db: { path: one },
        users: [
          { id: 'alice', dbPath: one, tokenSha256: hashes[0] },
          { id: 'bob', dbPath: two, tokenSha256: hashes[1] }
        ]
      }
    })
    expect(result.error).toBeUndefined()
    expect(result.config?.users).toHaveLength(2)
  })

  test('accepts legacy single-user configuration', async () => {
    const result = await loadFreshConfig({ configFile: { db: { path: join(root, 'legacy.db') } } })
    expect(result.error).toBeUndefined()
    expect(result.config?.users).toEqual([])
  })
})
