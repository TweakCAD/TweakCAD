/**
 * Post-solve geometry sync.
 *
 * Some geometry fields are redundant with the points they are built from, and
 * the solver only moves points. An arc stores a `radius` but its shape is
 * defined by centre/start/end, so after a solve the stored number can
 * disagree with `|start - centre|` — and that disagreement is what the next
 * read sees.
 *
 * Extracted from the editor store so the build path shares one
 * implementation. Both now solve: the editor on every drag, the worker when a
 * parameter drives a dimension. Two copies of a "keep the cache honest" rule
 * is exactly the kind of thing that drifts.
 */

import type {
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from './types.ts';
import { extractParameterRefs } from '../expressions.ts';

/** Tolerance below which a radius difference is solver noise, not a change. */
const RADIUS_EPSILON = 1e-6;

/**
 * Update each arc's stored radius from its current centre-to-start distance.
 *
 * Returns the input map unchanged when nothing moved, so callers relying on
 * reference equality (Zustand selectors, immer drafts) skip needless work.
 */
export function syncDerivedGeometryFields(
  geometries: Map<SketchGeometryId, SketchGeometry>,
  points: Map<SketchPointId, SketchPoint>,
): Map<SketchGeometryId, SketchGeometry> {
  let next: Map<SketchGeometryId, SketchGeometry> | null = null;
  for (const [gid, g] of geometries) {
    if (g.type !== 'arc') continue;
    const c = points.get(g.centerId);
    const s = points.get(g.startId);
    if (!c || !s) continue;
    const r = Math.hypot(s.x - c.x, s.y - c.y);
    if (Math.abs(r - g.radius) > RADIUS_EPSILON) {
      if (!next) next = new Map(geometries);
      next.set(gid, { ...g, radius: r });
    }
  }
  return next ?? geometries;
}

/**
 * The parameter names this sketch's dimension expressions reference.
 *
 * `DeleteParameter` uses it to refuse deleting a parameter a sketch dimension
 * still uses: unlike a feature input, an unresolvable dimension does not fail
 * its feature — the sketch keeps its last solved shape — so the deletion would
 * otherwise go through and silently stop the parameter driving anything.
 */
export function sketchDimensionParameterRefs(
  editorModel: { constraints?: readonly unknown[] } | undefined,
): Set<string> {
  const refs = new Set<string>();
  for (const c of editorModel?.constraints ?? []) {
    const expr = (c as { expression?: unknown }).expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;
    for (const name of extractParameterRefs(expr)) refs.add(name);
  }
  return refs;
}

/**
 * Whether any dimension in this sketch is driven by a parameter expression.
 *
 * The gate for a build-time solve. Most sketches have no expressions, and a
 * solve per sketch per rebuild would be a real cost to impose on all of them
 * for a feature few use — so the check is a cheap scan of the constraint
 * list, and the solver is only loaded when it answers yes.
 */
export function sketchHasParametricDimensions(
  editorModel: { constraints?: readonly unknown[] } | undefined,
): boolean {
  const constraints = editorModel?.constraints;
  if (!constraints) return false;
  return constraints.some(c => {
    const expr = (c as { expression?: unknown }).expression;
    return typeof expr === 'string' && expr.trim() !== '';
  });
}
