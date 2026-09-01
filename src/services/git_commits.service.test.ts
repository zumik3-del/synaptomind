import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { closeDb } from '../db/init'
import { countGitCommitsService, listGitCommitsService, parseRemoteRepo } from './git_commits.service'

beforeEach(createTestDb)
afterEach(closeDb)

// ── parseRemoteRepo ──────────────────────────────────────────────────────────

test('parseRemoteRepo parses GitHub HTTPS url', () => {
  const result = parseRemoteRepo('https://github.com/owner/repo')
  expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' })
})

test('parseRemoteRepo parses Forgejo url with nested owner', () => {
  const result = parseRemoteRepo('https://forgejo.example.com/group/subgroup/repo')
  expect(result).toEqual({ host: 'forgejo.example.com', owner: 'group/subgroup', repo: 'repo' })
})

test('parseRemoteRepo returns null for invalid url', () => {
  expect(parseRemoteRepo('not-a-url')).toBeNull()
})

test('parseRemoteRepo returns null for missing repo', () => {
  expect(parseRemoteRepo('https://github.com/owner')).toBeNull()
})

test('parseRemoteRepo handles trailing slash', () => {
  const result = parseRemoteRepo('https://github.com/owner/repo/')
  expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' })
})

// ── listGitCommitsService ────────────────────────────────────────────────────

test('listGitCommitsService returns empty for fresh db', () => {
  const result = listGitCommitsService()
  expect(result).toEqual([])
})

// ── countGitCommitsService ───────────────────────────────────────────────────

test('countGitCommitsService returns 0 for fresh db', () => {
  expect(countGitCommitsService()).toBe(0)
})
