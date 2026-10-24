/**
 * Drag-time solving: anchor first, slide second, refuse third.
 *
 * Every drag gesture in the sketch editor runs through here — the live
 * preview in `SketchEditorStore` and the commit in the `SketchMovePoint` /
 * `SketchMovePointsBatch` handlers — so that what the user sees mid-drag is
 * exactly what lands in the document on release.
 *
 * ## Why anchoring alone isn't enough
 *
 * Anchoring maps to planegcs `fixed: true`, which removes the point's x/y
 * from the parameter vector. That is the right default: it keeps the
 * user-driven position authoritative so coincident-linked neighbours follow
 * the drag instead of averaging against it.
 *
 * But it makes a constraint structurally unsatisfiable as soon as every
 * point that constraint touches is out of the parameter vector. Drag the
 * free end of a line whose other end is the fixed origin, with `horizontal`
 * on it: `horizontal` needs `startY == endY`, both points are pinned, and no
 * free parameter can close the gap. planegcs converges on a least-squares
 * minimum with a non-zero residual, the post-solve residual check flags
 * every constraint, and — because the solution is never applied — the rest
 * of the sketch stays where it was pushed. Coincident partners that had
 * nothing to do with the drag visibly detach, and the torn state gets
 * written to the document on release.
 *
 * ## The three tiers
 *
 * 1. **Anchored.** The moved set stays pinned. Fast path, unchanged
 *    behaviour for the common case: neighbours adjust, the drag wins.
 * 2. **Soft.** Re-solve with nothing anchored, but with a weak
 *    [[DragTarget]] pulling each moved point toward where it was dropped.
 *    Real constraints outweigh the target, so they are satisfied first; the
 *    target then decides where the point settles within the freedom they
 *    leave. The dragged point slides *along* the constraint rather than
 *    breaking it, and still tracks the cursor in every unconstrained
 *    direction — the behaviour mainstream parametric CAD has.
 *
 *    Seeding alone is not enough here. Least-squares distributes the
 *    correction across everything that moved, so on a chain of coincident
 *    points the single dragged point gets pulled back further than its
 *    partners and the drag reads as inert. The target is what keeps the
 *    user's intent in the objective.
 * 3. **Refuse.** Neither tier satisfies the sketch, so the drag is a no-op:
 *    `null`, and the caller leaves state untouched. A gesture that cannot
 *    produce a consistent sketch must not leave a torn one behind. For a
 *    sketch that was already over-constrained this means its geometry is
 *    undraggable until the offending constraint is removed, which is the
 *    honest reading of "over-constrained".
 *
 * Tier 2 costs a second solve, but only on a gesture that would otherwise
 * have produced a broken sketch.
 */

import type {
  SketchConstraint,
  SketchConstraintId,
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '../types.ts';
import type { DragTarget, ISketchSolver, SolveResult } from './ISketchSolver.ts';

const NOTHING_ANCHORED: ReadonlySet<SketchPointId> = new Set<SketchPointId>();

/**
 * Solve a sketch whose points have already been moved to their drag
 * destinations.
 *
 * @param solver     Active solver (callers pass `getSolver()`).
 * @param points     Point map with the drag already applied.
 * @param geometries Geometry map.
 * @param constraints Constraint map.
 * @param anchored   The moved set, to pin on the first attempt.
 * @returns A consistent solve result, or `null` when the drag cannot
 *   produce one and the caller should discard it.
 */
export function solveDrag(
  solver: ISketchSolver,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
  constraints: ReadonlyMap<SketchConstraintId, SketchConstraint>,
  anchored: ReadonlySet<SketchPointId>,
): SolveResult | null {
  const pinned = solver.solve(points, geometries, constraints, anchored);
  if (pinned.diagnostic.converged) return pinned;

  // Nothing to gain from a second pass if the first one had no anchors to
  // drop — it would be the identical system.
  if (anchored.size === 0) return null;

  // Trade each hard anchor for a soft target at the same position.
  const targets = new Map<SketchPointId, DragTarget>();
  for (const id of anchored) {
    const pt = points.get(id);
    if (pt) targets.set(id, { x: pt.x, y: pt.y });
  }

  const soft = solver.solve(points, geometries, constraints, NOTHING_ANCHORED, targets);
  if (soft.diagnostic.converged) return soft;

  return null;
}
