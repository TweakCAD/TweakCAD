/**
 * Solver registry.
 *
 * Single entry point the editor uses to get an [[ISketchSolver]].
 * planegcs (the WASM constraint solver) is the only implementation. An
 * in-house Levenberg-Marquardt solver that used to sit alongside it was
 * retired — same constraint vocabulary, weaker numerics, no real
 * workflow needed it.
 *
 * Why keep the [[ISketchSolver]] interface for a single implementation:
 * cheap insurance. If planegcs ever has a critical bug or gets
 * unmaintained, a second solver can be dropped back in behind the same
 * seam.
 *
 * Boot ordering: the app's `planegcsLoader.initPlaneGCS()` runs at app
 * boot and calls `attachPlaneGCSWrapper(wrapper)` once the WASM module
 * has loaded. Until that resolves, `getSolver()` throws
 * `PlaneGCSNotReadyError` — the demo seed in `appInit.ts` builds
 * fixtures by direct entity construction (no solver calls), so the only
 * way to race the boot is to interact with a sketch within the ~few
 * hundred ms WASM takes to load. Pre-launch this is acceptable; a
 * production boot indicator can light up the sketch tools only after
 * the registry reports ready.
 */

import { PlaneGCSSolver, PlaneGCSNotReadyError } from './PlaneGCSSolver.ts';
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { ISketchSolver } from './ISketchSolver.ts';

export type { ISketchSolver, SolveResult, SolverKind } from './ISketchSolver.ts';
export { solveDrag } from './solveDrag.ts';

const planegcsSolver = new PlaneGCSSolver();

/**
 * Attach a planegcs WASM wrapper to the registry. Called by the app's
 * planegcsLoader after `await make_gcs_wrapper(wasmPath)` resolves. The
 * registry owns the singleton PlaneGCSSolver instance — the loader's only
 * job is to bridge the browser-only WASM init into the platform-agnostic
 * registry. Safe to call multiple times; second+ are no-ops.
 *
 * @returns The PlaneGCSSolver instance (now ready) so the loader can
 *   surface readiness state if it wants.
 */
export function attachPlaneGCSWrapper(wrapper: GcsWrapper): PlaneGCSSolver {
  if (!planegcsSolver.ready) planegcsSolver.attach(wrapper);
  return planegcsSolver;
}

/**
 * Direct access to the planegcs singleton. Useful for tests that want to
 * assert `ready` without going through `getSolver()`'s throw-on-not-ready
 * path. Editor code should use `getSolver()` instead.
 */
export function getPlaneGCSSolver(): PlaneGCSSolver {
  return planegcsSolver;
}

/**
 * Return the active solver. Throws `PlaneGCSNotReadyError` if the WASM
 * module hasn't loaded yet — see module docstring for boot ordering. The
 * `SketchApplyConstraint` handler catches this as a HOST_ERROR Result.
 */
export function getSolver(): ISketchSolver {
  if (!planegcsSolver.ready) throw new PlaneGCSNotReadyError();
  return planegcsSolver;
}
