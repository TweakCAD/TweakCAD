/**
 * Sketch solver interface.
 *
 * Adapter seam between the editor and the constraint solver. The only
 * implementation is `PlaneGCSSolver` (planegcs via WASM); the interface
 * stays so a future swap doesn't ripple through every caller.
 *
 * Why sync: planegcs needs `await make_gcs_wrapper()` to load the
 * WASM module, but once initialised every individual solve call is
 * synchronous. The boot path (the app's `planegcsLoader`) runs that
 * init eagerly so the editor only sees sync solves — keeps the
 * Zustand store + tools free of `await` plumbing.
 *
 * Why a class (vs. a plain function): solver implementations hold
 * state. planegcs's `GcsWrapper` owns the WASM heap and is reused
 * across solves rather than rebuilt each call.
 */

import type {
  SketchConstraint,
  SketchConstraintId,
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '../types.ts';

/**
 * Identifier for which solver implementation is active. Only one value
 * today (`'planegcs'`); the type stays a union so a future second
 * implementation doesn't change the shape.
 */
export type SolverKind = 'planegcs';

/**
 * Result of a solver run. `geometries` is the updated map (may equal
 * input by reference if no geometry params moved); `unsatisfied`
 * reports constraint IDs still above tolerance after solve.
 */
export interface SolveResult {
  points: Map<SketchPointId, SketchPoint>;
  geometries: Map<SketchGeometryId, SketchGeometry>;
  diagnostic: {
    converged: boolean;
    finalCost: number;
    unsatisfied: Set<SketchConstraintId>;
    /**
     * Remaining degrees of freedom after the solve, as reported by the
     * solver. 0 = fully defined (every free parameter is pinned by some
     * constraint). >0 = under-constrained (the sketch can still wiggle
     * along that many dimensions). For planegcs, this comes from
     * `GcsSystem.dof()` after `solve_system()`. `undefined` when the
     * solver doesn't expose a DOF readout (kept optional so future
     * solver implementations don't have to compute it).
     */
    dof?: number;
  };
}

export interface ISketchSolver {
  readonly kind: SolverKind;
  /**
   * Whether this solver is ready to accept `solve()` calls. planegcs
   * is ready only after its WASM module has loaded. Callers usually go
   * through the registry's `getSolver()` which throws when not ready;
   * `ready` is exposed mainly for tests and a future boot-state
   * indicator.
   */
  readonly ready: boolean;

  solve(
    points: ReadonlyMap<SketchPointId, SketchPoint>,
    geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
    constraints: ReadonlyMap<SketchConstraintId, SketchConstraint>,
    anchored: ReadonlySet<SketchPointId>,
    dragTargets?: ReadonlyMap<SketchPointId, DragTarget>,
  ): SolveResult;
}

/**
 * A position the solver should pull a point toward *without* pinning it.
 *
 * Anchoring removes a point from the parameter vector, which makes any
 * constraint touching only anchored/fixed points unsatisfiable. A drag target
 * is the soft alternative: the point stays free, so real constraints are
 * satisfied first, and the target only decides where the point lands within
 * the freedom those constraints leave. Used by `solveDrag`'s fallback tier so
 * a dragged point slides along its constraint instead of breaking it.
 */
export interface DragTarget {
  x: number;
  y: number;
}
