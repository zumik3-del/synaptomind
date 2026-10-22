import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mainCheckoutRoot, resolveVec0, VEC0_FILENAME } from './vec0-fallback'

/**
 * The fallback that makes `bun run test:all` work in a fresh worktree
 * (task #1935). These pin the resolution order and, above all, the limit: a
 * local extension always wins, so a broken local copy is never masked.
 */
describe('vec0 fallback resolution', () => {
	let root: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'synaptomind-vec0-fallback-'))
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	function touch(path: string): string {
		mkdirSync(join(path, '..'), { recursive: true })
		writeFileSync(path, '')
		return path
	}

	/** A main checkout at `<root>/main` plus a linked worktree at `<root>/tree`. */
	function worktreePair(): { main: string; tree: string } {
		const main = join(root, 'main')
		const tree = join(root, 'tree')
		mkdirSync(join(main, '.git', 'worktrees', 't1'), { recursive: true })
		mkdirSync(tree, { recursive: true })
		writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 't1')}\n`)
		return { main, tree }
	}

	test('reads the main checkout out of a worktree .git file', () => {
		const { main, tree } = worktreePair()
		expect(mainCheckoutRoot(tree)).toBe(resolve(main))
	})

	test('a main checkout (directory .git) has no parent checkout', () => {
		const main = join(root, 'main')
		mkdirSync(join(main, '.git'), { recursive: true })
		expect(mainCheckoutRoot(main)).toBeNull()
	})

	test('a checkout without .git has no parent checkout', () => {
		const plain = join(root, 'plain')
		mkdirSync(plain, { recursive: true })
		expect(mainCheckoutRoot(plain)).toBeNull()
	})

	test('no local copy: falls back to the main checkout extension', () => {
		const { main, tree } = worktreePair()
		const expected = touch(join(main, VEC0_FILENAME))
		expect(resolveVec0({ repoRoot: tree })).toEqual({
			path: expected,
			source: 'main-checkout',
		})
	})

	test('repo-root copy wins over the main checkout', () => {
		const { main, tree } = worktreePair()
		touch(join(main, VEC0_FILENAME))
		const local = touch(join(tree, VEC0_FILENAME))
		expect(resolveVec0({ repoRoot: tree })).toEqual({
			path: local,
			source: 'repo-root',
		})
	})

	test('working-directory copy wins over the repo root and main checkout', () => {
		const { main, tree } = worktreePair()
		touch(join(main, VEC0_FILENAME))
		touch(join(tree, VEC0_FILENAME))
		const nested = join(tree, 'src')
		const local = touch(join(nested, VEC0_FILENAME))
		expect(resolveVec0({ repoRoot: tree, cwd: nested })).toEqual({
			path: local,
			source: 'cwd',
		})
	})

	test('nothing local and no main checkout: no resolution', () => {
		const plain = join(root, 'plain')
		mkdirSync(plain, { recursive: true })
		expect(resolveVec0({ repoRoot: plain })).toBeNull()
	})
})
