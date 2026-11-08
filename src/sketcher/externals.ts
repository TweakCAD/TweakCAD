/**
 * External curve rows (8.1 `external`) from a picked model entity: one row
 * for a projected edge; one row per curve of an intersection, each with
 * the `index`, `count` and `near` the editor writes when it makes the rows,
 * so a later reordering of the section pauses instead of being followed.
 * Rows are defining, so they bound regions; the construction toggle takes
 * them out.
 */
import { prepareCurve, type CurveShape } from '@tweakcad/format';
import type { Json, RowMaker } from './rows';
import type { ExternalShape } from './solve';

export type ExternalMode = 'project' | 'intersect';

/** A curve's start in its format direction (8.1), as `near` records it. */
export function startOf(shape: CurveShape): [number, number] {
  switch (shape.kind) {
    case 'line':
    case 'arc':
    case 'ellipticalArc':
      return [shape.start[0], shape.start[1]];
    case 'circle':
      return [shape.center[0] + shape.radius, shape.center[1]];
    case 'ellipse':
      return [shape.majorEnd[0], shape.majorEnd[1]];
    default: {
      const curve = prepareCurve(shape, false);
      const p = curve ? curve.point(curve.tMin) : [0, 0];
      return [p[0] as number, p[1] as number];
    }
  }
}

/**
 * The rows for the curves a pick yields, in the order the evaluator counts
 * them, with their shapes for the editor's solve until evaluation builds them.
 */
export function externalRows(
  make: RowMaker,
  source: Json,
  mode: ExternalMode,
  shapes: readonly CurveShape[],
): { rows: Json[]; shapes: ExternalShape[] } {
  const rows: Json[] = [];
  const built: ExternalShape[] = [];
  shapes.forEach((shape, index) => {
    const row: Json = {
      ...make.curve('external', false),
      source,
      defining: make.flag(true),
      mode: make.value(`"${mode}"`),
      ...(mode === 'project' ? {} : { index, count: shapes.length, near: startOf(shape) }),
    };
    rows.push(row);
    built.push({ id: row.id as string, shape, bounds: true });
  });
  return { rows, shapes: built };
}
