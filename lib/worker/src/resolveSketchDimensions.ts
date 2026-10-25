/**
 * Apply parameter expressions to a sketch's dimension constraints, then
 * re-solve.
 *
 * This is what makes a sketch parametric. Feature inputs have always been
 * `Expression` — extrude depth, fillet radius, hole diameter — so a parameter
 * could change how far a profile was pushed, but never the profile itself.
 * Sketch constraint values were bare numbers, and nothing in the build path
 * could solve, so there was no mechanism by which `pcd` could set a bolt
 * circle's diameter.
 *
 * ## Why solve rather than substitute
 *
 * Writing the resolved number onto the constraint is not enough. A dimension
 * is a constraint, not a coordinate: changing "these two points are 10 mm
 * apart" to 20 mm says nothing about *where* the points go — that is the
 * solver's job, and it has to respect every other constraint while doing it.
 * Substituting without solving would leave geometry that contradicts its own
 * constraints, which is exactly the state the sketch editor exists to prevent.
 *
 * ## Degrading
 *
 * A sketch with no expressions is returned untouched and never solved — the
 * overwhelming majority of sketches, and the reason this is cheap. Only
 * sketches that actually reference a parameter pay for a solve.
 */

import type { SketchConstraint } from '@tweakcad/core/src/sketch/types.ts';
import type { EditorState } from '@tweakcad/core/src/sketch/operations.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { getSolver } from '@tweakcad/core/src/sketch/solver/index.ts';
import { syncDerivedGeometryFields } from '@tweakcad/core/src/sketch/derivedFields.ts';

/** Constraint kinds whose `value` a parameter can drive. */
function hasExpression(
  c: SketchConstraint,
): c is SketchConstraint & { expression: string; value: number } {
  return (
    typeof (c as { expression?: unknown }).expression === 'string' &&
    (c as { expression: string }).expression.trim() !== ''
  );
}

export type SketchResolveResult = {
  state: EditorState;
  /** Expressions that could not be evaluated, or a solve that failed. */
  diagnostics: string[];
  /** True when a solve actually ran. */
  solved: boolean;
};

/**
 * @param state  The sketch's editor model.
 * @param params Resolved project + part parameters for this rebuild.
 */
export function resolveSketchDimensions(
  state: EditorState,
  params: ResolvedParams,
): SketchResolveResult {
  const diagnostics: string[] = [];

  const parametric = [...state.constraints.values()].filter(hasExpression);
  if (parametric.length === 0) {
    return { state, diagnostics, solved: false };
  }

  // Apply every resolved value first, then solve once. Solving per constraint
  // would let an early solve move geometry that a later constraint is about
  // to re-pin, and the result would depend on map iteration order.
  const constraints = new Map(state.constraints);
  let applied = 0;
  for (const c of parametric) {
    const evaluated = evaluateExpression(c.expression, params);
    if (!evaluated.ok) {
      diagnostics.push(
        `Dimension "${c.expression}" could not be evaluated: ${evaluated.error}`,
      );
      continue; // keep the last solved value rather than zeroing the dimension
    }
    constraints.set(c.id, { ...c, value: evaluated.value } as SketchConstraint);
    applied++;
  }

  if (applied === 0) return { state, diagnostics, solved: false };

  const next: EditorState = { ...state, constraints };
  const result = getSolver().solve(next.points, next.geometries, next.constraints, new Set());

  if (!result.diagnostic.converged) {
    // Report and keep the geometry as authored. A sketch that cannot satisfy
    // its parameters is over-constrained, and building the unsolved result is
    // more useful than failing the feature outright — the user sees the shape
    // they drew plus a diagnostic naming the problem.
    diagnostics.push(
      `Sketch could not be solved with the current parameter values ` +
        `(${result.diagnostic.unsatisfied.size} constraint(s) unsatisfied).`,
    );
    return { state, diagnostics, solved: false };
  }

  return {
    state: {
      ...next,
      points: result.points,
      // Arc radius is recomputed from |start - centre| after every solve.
      geometries: syncDerivedGeometryFields(result.geometries, result.points),
    },
    diagnostics,
    solved: true,
  };
}
