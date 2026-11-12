/**
 * One probe per declared fingerprint input of every converted action (task
 * #2492).
 *
 * The keys are NOT the input set: the set is read from each action's own
 * `fingerprintOf(...)` declaration (`confirm-gate-declaration.ts`), and a probe
 * key only has to identify one declared part as a unique substring of it, in
 * both directions (every part covered, every key bound). So a part dropped from
 * the fold, or reworded past its key, breaks the binding test instead of
 * silently shrinking the matrix.
 *
 * A probe changes ONE input's underlying state and returns the arguments of the
 * confirm that must then be refused. `refusal` is the gate's reading of that
 * change: `stale` when the state moved under a fixed target, `target_mismatch`
 * when the input is the object's identity and is therefore also the token's
 * target — such a part cannot move alone, and `consumePreviewTokenService`
 * compares that target before the fingerprint, so the fold of it is redundant
 * (the mutant table in task #2492's comment lists the parts a single dropped
 * argument therefore cannot expose).
 *
 * The rows are split by token scope so each module stays readable:
 * `confirm-gate-fingerprints.edges.ts` (edges, runs, placement proposals),
 * `confirm-gate-fingerprints.thoughts.ts` (thoughts and the merge pair) and
 * `confirm-gate-fingerprints.pools.ts` (the cluster candidate pool, a project,
 * the primer set); `confirm-gate-fingerprints.types.ts` holds the probe shape
 * and the change helpers. All test-only, under `src/test/` so neither
 * `bun:test` nor the fixtures reach the production path.
 */
import { EDGE_FINGERPRINT_CASES } from './confirm-gate-fingerprints.edges'
import { POOL_FINGERPRINT_CASES } from './confirm-gate-fingerprints.pools'
import { THOUGHT_FINGERPRINT_CASES } from './confirm-gate-fingerprints.thoughts'
import type { FingerprintCase } from './confirm-gate-fingerprints.types'

export type {
  FingerprintCase,
  FingerprintProbe,
  RefusalReading
} from './confirm-gate-fingerprints.types'

/** Every declared fingerprint input of the 12 converted actions, with its probes. */
export const FINGERPRINT_CASES: readonly FingerprintCase[] = [
  ...EDGE_FINGERPRINT_CASES,
  ...THOUGHT_FINGERPRINT_CASES,
  ...POOL_FINGERPRINT_CASES
]
