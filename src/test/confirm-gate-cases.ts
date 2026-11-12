/**
 * Fixture matrix for the confirm-gate contract suite (task #2466).
 *
 * One entry per converted destructive action: how to build its fixture, what a
 * confirm must have changed, what a stale refusal must leave untouched, and
 * which layer refuses a replayed confirm — the gate (the target is still
 * readable, so the burned token reads `not_found`) or the domain (the confirm
 * deleted its own target, so there is nothing left to guard and the action's
 * own not-found answer stands).
 *
 * The rows are split by token scope so each module stays readable:
 * `confirm-gate-cases.edges.ts` (edge/proposal/batch ids) and
 * `confirm-gate-cases.thoughts.ts` (thoughts, the cluster pool, projects,
 * primers); `confirm-gate-cases.types.ts` holds the shape and the DB probes.
 * All test-only, under `src/test/` so neither `bun:test` nor the fixtures reach
 * the production path.
 */
import { EDGE_GATE_CASES } from './confirm-gate-cases.edges'
import { THOUGHT_GATE_CASES } from './confirm-gate-cases.thoughts'
import type { GateCase } from './confirm-gate-cases.types'

export type { GateCase, GateKind } from './confirm-gate-cases.types'

/** Every converted preview/confirm site (12 actions over 10 tool modules). */
export const GATE_CASES: readonly GateCase[] = [...EDGE_GATE_CASES, ...THOUGHT_GATE_CASES]
