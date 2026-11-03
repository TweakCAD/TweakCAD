/**
 * Apply-constraint pipeline — the shared dedupe + tentative-solve +
 * conflict-detection + auto-resize flow used by the document-level
 * command handler (`SketchApplyConstraint`). Single call site — the
 * editor-store-side `addConstraint` action + its `conflictingConstraints`
 * bucket were retired and every UI path now dispatches through the bus,
 * so the dedupe / solver / auto-resize logic lives here in one place.
 *
 * **Why this lives in core.** The bus runs in core, the MCP client path
 * routes through the same bus, and the UI dispatches through the bus
 * too. Pre-commit rejection keeps the undo stack clean — rejected
 * constraints never enter the document. Rejection surfaces as a
 * structured `Result.err({code: 'CONSTRAINT_REJECTED'})` from
 * `bus.dispatch`, which UI converts to a toast via
 * `sketchDispatch.dispatchApplyConstraint`.
 *
 * **Pipeline:**
 *   1. **Dedupe.** Same constraint already exists (by structural equality)?
 *      Return `{ kind: 'duplicate', existingId }`. No solve.
 *   2. **Tentative solve.** Add the candidate to a clone of the constraint
 *      map, run the registered solver.
 *   3. **Failure check.** Three rejection modes (see `checkAddFailure`):
 *      - the new constraint itself is unsatisfied,
 *      - a previously-satisfied constraint became unsatisfied,
 *      - a non-trivial line collapsed to zero length.
 *   4. **Two-pass auto-resize.** If the first solve failed, nudge every
 *      free geometry dimension by ±2 % and resolve. If
 *      the perturbed solve passes the failure check, accept it.
 *   5. **Result.** `{ kind: 'applied', state, unsatisfied, usedPerturbation }`
 *      or `{ kind: 'rejected', reason }`.
 *
 * The helper does NOT mutate the input editor state. The caller decides
 * what to do with the returned state (write to document, set on store,
 * etc.) and how to surface the rejection (toast, command error, etc.).
 */

import type { ISketchSolver, SolveResult } from './solver/index.ts';
import { addConstraint as coreAddConstraint, type EditorState } from './operations.ts';
import { sketchConstraintId } from './types.ts';
import type {
  SketchConstraint,
  SketchConstraintId,
  SketchConstraintInput,
  SketchGeometry,
  SketchGeometryId,
} from './types.ts';

// ---- Structural equality (dedupe key) --------------------------------------

const VALUE_EPSILON = 1e-9;

/**
 * Two constraints are "equivalent" when they bind the same entities with
 * the same role. Symmetric kinds (coincident, parallel, perpendicular,
 * equal, circle-circle tangent) accept entity-order swaps. Signed kinds
 * (distanceX/Y, angle) keep order — swapping changes the constrained sign.
 */
export function constraintsEqual(a: SketchConstraint, b: SketchConstraint): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'horizontal':
    case 'vertical':
      return a.geometryId === (b as typeof a).geometryId;
    case 'fixed':
      return a.pointId === (b as typeof a).pointId;
    case 'coincident': {
      const bt = b as typeof a;
      return (a.pointA === bt.pointA && a.pointB === bt.pointB)
        || (a.pointA === bt.pointB && a.pointB === bt.pointA);
    }
    case 'distance': {
      const bt = b as typeof a;
      const same = (a.pointA === bt.pointA && a.pointB === bt.pointB)
        || (a.pointA === bt.pointB && a.pointB === bt.pointA);
      return same && Math.abs(a.value - bt.value) < VALUE_EPSILON;
    }
    case 'distanceX':
    case 'distanceY': {
      const bt = b as typeof a;
      return a.pointA === bt.pointA && a.pointB === bt.pointB
        && Math.abs(a.value - bt.value) < VALUE_EPSILON;
    }
    case 'radius':
    case 'length': {
      const bt = b as typeof a;
      return a.geometryId === bt.geometryId && Math.abs(a.value - bt.value) < VALUE_EPSILON;
    }
    case 'parallel':
    case 'perpendicular':
    case 'equal':
    case 'concentric': {
      const bt = b as typeof a;
      return (a.geometryA === bt.geometryA && a.geometryB === bt.geometryB)
        || (a.geometryA === bt.geometryB && a.geometryB === bt.geometryA);
    }
    case 'angle': {
      const bt = b as typeof a;
      return a.geometryA === bt.geometryA && a.geometryB === bt.geometryB
        && Math.abs(a.value - bt.value) < VALUE_EPSILON;
    }
    case 'tangent': {
      const bt = b as typeof a;
      if (a.lineId !== undefined && bt.lineId !== undefined) {
        return a.lineId === bt.lineId && a.circleId === bt.circleId;
      }
      if (a.secondCircleId !== undefined && bt.secondCircleId !== undefined) {
        // Circle-circle: refs match (order-insensitive) AND the same
        // `internal` flag. External + internal on the same pair are
        // distinct constraints, not duplicates — they specify different
        // geometric configurations.
        const refsMatch = (a.circleId === bt.circleId && a.secondCircleId === bt.secondCircleId)
          || (a.circleId === bt.secondCircleId && a.secondCircleId === bt.circleId);
        return refsMatch && (a.internal === true) === (bt.internal === true);
      }
      return false;
    }
    case 'pointOnLine':
    case 'pointOnCircle':
    case 'midpoint': {
      const bt = b as typeof a;
      return a.pointId === bt.pointId && a.geometryId === bt.geometryId;
    }
    case 'symmetric': {
      const bt = b as typeof a;
      if (a.geometryId !== bt.geometryId) return false;
      return (a.pointA === bt.pointA && a.pointB === bt.pointB)
        || (a.pointA === bt.pointB && a.pointB === bt.pointA);
    }
  }
}

// ---- Free-dimension perturbation (Pass 2) ----------------------------------

/**
 * Deterministic ±2 % nudge of every FREE geometry dimension (circle
 * radius, ellipse minor radius, slot width). Used as the second-pass
 * initial guess when the solver gets stuck at the current state — the
 * perturbed start lets it find a satisfying configuration when one
 * exists but lives on the other side of a local minimum.
 *
 * Dimensions pinned by an explicit `radius` or `length` constraint are
 * NOT perturbed — the user locked those values. Returns the input map
 * by reference when there's nothing to perturb so the caller can detect
 * a no-op and skip Pass 2.
 */
function perturbFreeDimensions(
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
  constraints: ReadonlyMap<SketchConstraintId, SketchConstraint>,
): Map<SketchGeometryId, SketchGeometry> {
  const pinned = new Set<SketchGeometryId>();
  for (const c of constraints.values()) {
    if (c.type === 'radius' || c.type === 'length') pinned.add(c.geometryId);
  }
  let changed = false;
  const out = new Map(geometries);
  let i = 0;
  for (const [id, g] of geometries) {
    if (pinned.has(id)) continue;
    const nudge = (i++ % 2 === 0 ? 1 : -1) * 0.02;
    if (g.type === 'circle') {
      out.set(id, { ...g, radius: g.radius * (1 + nudge) });
      changed = true;
    } else if (g.type === 'ellipse') {
      out.set(id, { ...g, minorRadius: g.minorRadius * (1 + nudge) });
      changed = true;
    }
    // There is no `slot` (composite) editor geometry; slots decompose at
    // draw time into 2 lines + 2 arcs whose dimensions come from the
    // underlying point coords — already perturbed by the point-axis
    // nudges, no slot-specific case needed.
  }
  return changed ? out : (geometries as Map<SketchGeometryId, SketchGeometry>);
}

// ---- Failure classification ------------------------------------------------

/** Why a tentative solve was rejected. */
export type AddFailure = { failed: true; reason: string } | { failed: false; reason: '' };

/**
 * Three rejection modes — any one fails the candidate:
 *   - `cannot be satisfied` — the new constraint itself ended above tolerance.
 *   - `would break another already-satisfied constraint` — a previously-
 *     satisfied constraint became unsatisfied.
 *   - `would collapse a line to zero length` — a real line (> 0.5 mm)
 *     shrunk to a point; tangent's `cross/L` reads 0 when L → 0 so this
 *     is the solver's degenerate "escape" from "satisfy tangent by
 *     collapsing the line".
 */
/** The rejection reason for a previously-satisfied constraint becoming unsatisfied. */
const BREAKS_ANOTHER = 'would break another already-satisfied constraint';

export function checkAddFailure(
  candidateId: SketchConstraintId,
  result: SolveResult,
  beforeState: EditorState,
  prevUnsatisfied: ReadonlySet<SketchConstraintId>,
): AddFailure {
  if (result.diagnostic.unsatisfied.has(candidateId)) {
    return { failed: true, reason: 'cannot be satisfied' };
  }
  for (const cid of result.diagnostic.unsatisfied) {
    if (cid === candidateId) continue;
    if (!prevUnsatisfied.has(cid)) {
      return { failed: true, reason: BREAKS_ANOTHER };
    }
  }
  for (const [, g] of beforeState.geometries) {
    if (g.type !== 'line') continue;
    const a = beforeState.points.get(g.startId);
    const b = beforeState.points.get(g.endId);
    if (!a || !b) continue;
    const origLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (origLen < 0.5) continue;
    const a2 = result.points.get(g.startId);
    const b2 = result.points.get(g.endId);
    if (!a2 || !b2) continue;
    const newLen = Math.hypot(b2.x - a2.x, b2.y - a2.y);
    if (newLen < 0.5) {
      return { failed: true, reason: 'would collapse a line to zero length' };
    }
  }
  return { failed: false, reason: '' };
}

// ---- Pipeline orchestrator -------------------------------------------------

export type ApplyConstraintPipelineResult =
  /** An equivalent constraint already exists — caller should reuse its id. */
  | { kind: 'duplicate'; existingId: SketchConstraintId }
  /**
   * Solver couldn't satisfy the candidate without breaking the sketch.
   * Caller decides how to surface (toast, error result, etc.). No state
   * change is returned.
   */
  | { kind: 'rejected'; reason: string; constraint: SketchConstraint }
  /**
   * Candidate accepted. `state` carries the new constraint plus the
   * solver's post-solve points + geometries. `unsatisfied` is the
   * solver's residual list (rare — only for pre-existing conflicts).
   * `usedPerturbation` is true when the second-pass ±2 % nudge was
   * needed; caller may want to inform the user that geometry was
   * adjusted.
   */
  | {
      kind: 'applied';
      state: EditorState;
      constraintId: SketchConstraintId;
      unsatisfied: Set<SketchConstraintId>;
      usedPerturbation: boolean;
      /**
       * Remaining degrees of freedom after the solve. 0 = fully defined,
       * >0 = under-constrained. `undefined` when the solver doesn't
       * expose a DOF readout. Surfaced for the sketch panel's status
       * badge ("Under-constrained · 3 DOF" / "Fully defined").
       */
      dof?: number;
    };

/**
 * Add a constraint to an editor state, run the solver, and decide
 * whether to accept or reject. See module docstring for the full
 * pipeline.
 *
 * `prevUnsatisfied` is the set of constraint IDs that the solver
 * already considered unsatisfied BEFORE this add, so they don't count as
 * broken by it. Left out, it is worked out only when needed: if the add is
 * rejected for breaking another constraint, the sketch is solved as it
 * stands, and the add is checked again against what was already
 * unsatisfied. Assuming an empty set instead meant that one constraint left
 * unsatisfied — by an import, an edited dimension, a hand-edited file —
 * got every later add in that sketch rejected as breaking it.
 */
export function applyConstraintWithSolver(
  state: EditorState,
  constraintInput: SketchConstraintInput,
  solver: ISketchSolver,
  prevUnsatisfied?: ReadonlySet<SketchConstraintId>,
): ApplyConstraintPipelineResult {
  // 1. Dedupe — caller-supplied id (if any) is honored; otherwise we
  //    don't yet allocate one (no allocation if it turns out to be a dup).
  for (const existing of state.constraints.values()) {
    // Compare on the full shape; type-cast through SketchConstraint by
    // assuming a temporary id for the candidate.
    const candidate = { ...constraintInput, id: existing.id } as SketchConstraint;
    if (constraintsEqual(existing, candidate)) {
      return { kind: 'duplicate', existingId: existing.id };
    }
  }

  // 2. Append via the pure primitive so id allocation, immutability and
  //    constraint-map semantics stay in one place.
  const added = coreAddConstraint(state, constraintInput);
  const tentativeState = added.state;
  const candidateId = added.id;
  const candidate = tentativeState.constraints.get(candidateId)!;

  // 3. Tentative solve.
  let solveResult = solver.solve(
    tentativeState.points,
    tentativeState.geometries,
    tentativeState.constraints,
    new Set(),
  );
  let baseline: ReadonlySet<SketchConstraintId> = prevUnsatisfied ?? new Set();
  let failure = checkAddFailure(candidateId, solveResult, state, baseline);
  if (failure.failed && failure.reason === BREAKS_ANOTHER && prevUnsatisfied === undefined) {
    // Was the "broken" constraint already unsatisfied before this add?
    baseline = solver.solve(state.points, state.geometries, state.constraints, new Set())
      .diagnostic.unsatisfied;
    failure = checkAddFailure(candidateId, solveResult, state, baseline);
  }
  let usedPerturbation = false;

  // 4. Two-pass auto-resize.
  if (failure.failed) {
    const perturbed = perturbFreeDimensions(tentativeState.geometries, tentativeState.constraints);
    if (perturbed !== tentativeState.geometries) {
      const r2 = solver.solve(
        tentativeState.points,
        perturbed,
        tentativeState.constraints,
        new Set(),
      );
      const f2 = checkAddFailure(candidateId, r2, state, baseline);
      if (!f2.failed) {
        solveResult = r2;
        failure = f2;
        usedPerturbation = true;
      }
    }
  }

  if (failure.failed) {
    return { kind: 'rejected', reason: failure.reason, constraint: candidate };
  }

  // 5. Accept — build the new editor state with solver-updated coords.
  const finalState: EditorState = {
    points: solveResult.points,
    geometries: solveResult.geometries,
    constraints: tentativeState.constraints,
  };
  return {
    kind: 'applied',
    state: finalState,
    constraintId: candidateId,
    unsatisfied: solveResult.diagnostic.unsatisfied,
    usedPerturbation,
    ...(solveResult.diagnostic.dof !== undefined ? { dof: solveResult.diagnostic.dof } : {}),
  };
}

// Re-export sketchConstraintId so callers that want to allocate an id
// up-front (for dedupe-key parity with the legacy store) can do so via
// the same brand helper this module uses.
export { sketchConstraintId };
