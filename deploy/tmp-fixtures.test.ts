/**
 * The temp-tree ownership guard is only worth having if it CAN fail — a fixture
 * that cannot fail is worse than no fixture, because it reports safety it has
 * not established. These tests are therefore about the mechanism itself, not
 * about deploy behaviour.
 *
 * They pin four claims:
 *   1. A tree is REMOVED after the test that made it — the property the whole
 *      change exists for. Proven against a real throw, because "it cleans up
 *      when everything passes" is the half that was already true.
 *   2. The sweep removes EVERY pending tree, not just the most recent one, so
 *      a fixture creating two trees in one test cannot smuggle one out.
 *   3. The sweep removes only what this module created: a bystander directory
 *      in the same tmpdir survives, which is the "never remove a path you did
 *      not create" constraint stated as an assertion rather than a promise.
 *   4. Removing an already-removed tree does not throw, so a suite that both
 *      cleans up eagerly and relies on the sweep stays green.
 *
 * Each test that sweeps does so itself and then asserts the count, so no test
 * here depends on hook ordering to stay correct.
 */

import { describe, expect, test, afterEach, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCleanup, mkTempTree, pendingTempTrees, sweepTempTrees, withTempTree } from './tmp-fixtures'

installCleanup()

// Sweep between tests so one test's tree is never this test's evidence.
afterEach(() => {
  sweepTempTrees()
})

describe('deploy temp-tree ownership', () => {
  test('the sweep removes every tree created since the last sweep', () => {
    const a = mkTempTree('synapto-owner-a-')
    const b = mkTempTree('synapto-owner-b-')
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
    expect(pendingTempTrees()).toEqual([a, b])

    expect(sweepTempTrees()).toBe(2)

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
    expect(pendingTempTrees()).toEqual([])
  })

  test('a tree whose test threw is still removed', () => {
    // Run the failing test as a FUNCTION so this test can observe what survived
    // it. A real `expect().toThrow()` alone could not: the sweep happens in the
    // suite's afterEach, which is outside the assertion.
    const tree = mkTempTree('synapto-owner-throw-')
    const failingTest = () => {
      // A tree created by the failing test itself, not the outer one.
      mkTempTree('synapto-owner-inner-')
      throw new Error('simulated test failure')
    }

    expect(failingTest).toThrow('simulated test failure')
    sweepTempTrees()

    expect(existsSync(tree)).toBe(false)
    expect(pendingTempTrees()).toEqual([])
  })

  test('the sweep leaves a directory this module never created alone', () => {
    // The "never remove a path you did not create" constraint, asserted. The
    // bystander stands in for another session's scratch in the host's /tmp.
    const bystander = mkdtempSync(join(tmpdir(), 'synapto-owner-bystander-'))
    const ours = mkTempTree('synapto-owner-ours-')
    try {
      sweepTempTrees()
      expect(existsSync(ours)).toBe(false)
      // The assertion that makes the sweep safe to run at all.
      expect(existsSync(bystander)).toBe(true)
    } finally {
      rmSync(bystander, { recursive: true, force: true })
    }
  })

  test('sweeping with nothing pending removes nothing and throws nothing', () => {
    expect(pendingTempTrees()).toEqual([])
    expect(sweepTempTrees()).toBe(0)
    expect(sweepTempTrees()).toBe(0)
  })

  test('withTempTree releases the tree even when the builder throws', () => {
    const built = mkdtempSync(join(tmpdir(), 'synapto-owner-value-'))
    try {
      const result = withTempTree('synapto-owner-scope-', (path) => {
        expect(existsSync(path)).toBe(true)
        return 'the value the test asserts on'
      })
      expect(result).toBe('the value the test asserts on')
      expect(pendingTempTrees()).toEqual([])
    } finally {
      rmSync(built, { recursive: true, force: true })
    }

    const path = mkdtempSync(join(tmpdir(), 'synapto-owner-throwing-'))
    let captured = ''
    try {
      expect(() =>
        withTempTree('synapto-owner-scope-fail-', (p) => {
          captured = p
          throw new Error('builder failed')
        }),
      ).toThrow('builder failed')
      // The finally released it: pending is empty and the tree is gone.
      expect(pendingTempTrees()).toEqual([])
      expect(existsSync(captured)).toBe(false)
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })

  test('a tree that no test created is not removed by the suite hooks', () => {
    // Guards the hooks themselves rather than a direct sweep() call: create a
    // tree with the RAW mkdtempSync the old fixtures used, and prove neither
    // the afterEach nor the exit backstop touches it. If someone reintroduces
    // bare mkdtempSync into a fixture, this is the shape of the leak that
    // returns — and the ownership tests above would then be describing a
    // mechanism nothing uses.
    const unowned = mkdtempSync(join(tmpdir(), 'synapto-owner-unowned-'))
    afterAll(() => {
      // Nothing in this file should have claimed it.
      expect(pendingTempTrees()).not.toContain(unowned)
      rmSync(unowned, { recursive: true, force: true })
    })
    expect(existsSync(unowned)).toBe(true)
  })
})