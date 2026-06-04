/**
 * Compute the remaining degrees-of-freedom for a sketch outside of edit
 * mode — i.e. from raw `SketchFeatureInputs` rather than the live
 * `SketchEditorStore`. Used by the project tree to render a Lock badge
 * on fully-defined sketches at-a-glance.
 *
 * Cost: one synchronous solver call (typically a few ms per sketch).
 * Safe to call inline during render — the document store changes its
 * `_editorState` reference only on real mutations, so React memoisation
 * cuts the call rate to actual changes.
 *
 * Returns `undefined` when:
 *   - the sketch has no `_editorState` snapshot yet (legacy `.cadjson`)
 *   - planegcs WASM isn't ready (`PlaneGCSNotReadyError`)
 *   - the solver throws for any other reason (defensive: a tree-render
 *     bug should never crash the whole UI)
 */

import { getSolver } from '@tweakcad/core/src/sketch/solver/index.ts';
import type {
  SketchPoint,
  SketchPointId,
  SketchGeometry,
  SketchGeometryId,
  SketchConstraint,
  SketchConstraintId,
} from '@tweakcad/core/src/sketch/types.ts';
import type { SketchFeatureInputs } from '@tweakcad/core/src/document/schema.ts';

export function computeSketchDof(inputs: SketchFeatureInputs): number | undefined {
  const ed = inputs._editorState;
  if (!ed) return undefined;
  try {
    const points = new Map<SketchPointId, SketchPoint>();
    for (const p of ed.points as SketchPoint[]) points.set(p.id, p);
    const geometries = new Map<SketchGeometryId, SketchGeometry>();
    for (const g of ed.geometries as SketchGeometry[]) geometries.set(g.id, g);
    const constraints = new Map<SketchConstraintId, SketchConstraint>();
    for (const c of ed.constraints as SketchConstraint[]) constraints.set(c.id, c);
    const result = getSolver().solve(points, geometries, constraints, new Set());
    return result.diagnostic.dof;
  } catch {
    return undefined;
  }
}
