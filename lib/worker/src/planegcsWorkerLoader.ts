/**
 * planegcs WASM init for the rebuild worker.
 *
 * The editor has always had a solver; the worker has not. That asymmetry is
 * why a parameter could drive a feature dimension (extrude depth, fillet
 * radius — all `Expression`) but never a sketch dimension: there was nothing
 * in the build path able to re-satisfy constraints after a parameter moved.
 *
 * Mirrors `src/sketch/solver/planegcsLoader.ts` rather than importing it: the
 * loader lives in the app bundle, and the worker is a separate entry. Both
 * attach to the same registry in core, so each context ends up with its own
 * wrapper over its own WASM instance — which is what we want. A `GcsWrapper`
 * owns a WASM heap and is reused across solves; sharing one across threads
 * would mean sharing that heap.
 *
 * Cost is modest: the module is ~476 KB against the ~21 MB OCCT build the
 * worker already loads.
 */

import { make_gcs_wrapper } from '@salusoft89/planegcs';
import planegcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { attachPlaneGCSWrapper, getPlaneGCSSolver } from '@tweakcad/core/src/sketch/solver/index.ts';

let initPromise: Promise<void> | null = null;

/**
 * Load planegcs and attach it to the registry for this worker.
 *
 * Idempotent and safe to call concurrently — the in-flight promise is shared,
 * so a burst of rebuilds during startup compiles the module once.
 */
export async function ensureSketchSolver(): Promise<void> {
  if (getPlaneGCSSolver().ready) return;
  initPromise ??= (async () => {
    const wrapper = await make_gcs_wrapper(planegcsWasmUrl);
    attachPlaneGCSWrapper(wrapper);
  })();
  await initPromise;
}

/**
 * Whether a build-time solve is possible right now.
 *
 * Lets `buildSketch` degrade instead of failing: a sketch with no parameter
 * expressions does not need the solver at all, so a solver that failed to
 * load should only break the sketches that actually depend on it.
 */
export function sketchSolverReady(): boolean {
  return getPlaneGCSSolver().ready;
}
