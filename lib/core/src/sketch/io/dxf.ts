/**
 * Sketch → DXF (AutoCAD ASCII DXF) export.
 *
 * EXPORT ONLY. Produces a minimal, valid R12-style ASCII DXF: a HEADER
 * section declaring millimetre units ($INSUNITS = 4), an ENTITIES section,
 * and the trailing EOF. Import is a separate, later phase and lives
 * elsewhere.
 *
 * Why native curve entities (not polyline approximations): our sketch
 * geometry already *is* lines, circles, arcs, ellipses, and splines — so we
 * emit native DXF LINE / CIRCLE / ARC / ELLIPSE / SPLINE entities rather
 * than flattening curves into dense polylines. The result is a clean,
 * editable DXF and exact CNC toolpaths.
 *
 * Conventions matched from the sketch model (see
 * `lib/worker/src/featureBuilders/buildSketch.ts` and
 * `lib/core/src/sketch/serialization.ts`):
 *
 *   - Coordinates are mm. Each entity field is an `Expression`; we evaluate
 *     it with `evaluateExpression(expr, params)` exactly as buildSketch does.
 *   - Arc `startAngle` / `endAngle` are stored in RADIANS, CCW, measured
 *     `atan2(p.y - center.y, p.x - center.x)`. DXF group codes 50/51 want
 *     DEGREES CCW, so we convert with `rad * 180 / π`. A point on the arc is
 *     `center + radius * (cos θ, sin θ)` — same as wireProfile.
 *   - Ellipse `majorEnd` is the ABSOLUTE coordinate of the major-axis
 *     endpoint. The DXF ELLIPSE major-axis vector (group 11/21) is relative
 *     to the centre, i.e. `majorEnd - center`; the axis ratio (group 40) is
 *     `minorRadius / |majorEnd - center|`. Rotation is implied by the
 *     direction of that vector — DXF needs no separate rotation field.
 *   - DXF Y is up, same as the sketch plane, so no Y flip here (that is an
 *     SVG-only concern).
 *
 * Excluded from output (reference geometry, not cut paths):
 *   - entities with `construction: true`
 *   - standalone `point` entities
 *
 * An empty sketch (or one containing only excluded entities) yields a valid
 * DXF with an empty ENTITIES section.
 */

import type {
  SketchEntity,
  SketchLineEntity,
  SketchCircleEntity,
  SketchArcEntity,
  SketchEllipseEntity,
  SketchSplineEntity,
  SketchBezierEntity,
} from '../../document/schema.ts';
import type { ResolvedParams, Expression } from '../../expressions.ts';
import { evaluateExpression } from '../../expressions.ts';

/** Evaluate an expression, returning `undefined` on any evaluation error. */
function evalExpr(expr: Expression, params: ResolvedParams): number | undefined {
  const r = evaluateExpression(expr, params);
  return r.ok ? r.value : undefined;
}

/** Format a number for a DXF coordinate/value group. */
function num(n: number): string {
  // DXF readers accept plain decimal; trim to a reasonable precision while
  // keeping integers clean. `Number.prototype.toString` already avoids
  // trailing zeros and only uses exponent form for extreme magnitudes that
  // never arise for mm-scale CAD coordinates.
  return String(n);
}

/** Emit a single group-code / value pair (two DXF lines). */
function group(code: number, value: string | number, out: string[]): void {
  out.push(String(code));
  out.push(typeof value === 'number' ? num(value) : value);
}

function writeLine(e: SketchLineEntity, params: ResolvedParams, out: string[]): void {
  const sx = evalExpr(e.start[0], params);
  const sy = evalExpr(e.start[1], params);
  const ex = evalExpr(e.end[0], params);
  const ey = evalExpr(e.end[1], params);
  if (sx === undefined || sy === undefined || ex === undefined || ey === undefined) return;
  group(0, 'LINE', out);
  group(8, '0', out); // layer 0
  group(10, sx, out);
  group(20, sy, out);
  group(30, 0, out);
  group(11, ex, out);
  group(21, ey, out);
  group(31, 0, out);
}

function writeCircle(e: SketchCircleEntity, params: ResolvedParams, out: string[]): void {
  const cx = evalExpr(e.center[0], params);
  const cy = evalExpr(e.center[1], params);
  const d = evalExpr(e.diameter, params);
  if (cx === undefined || cy === undefined || d === undefined) return;
  group(0, 'CIRCLE', out);
  group(8, '0', out);
  group(10, cx, out);
  group(20, cy, out);
  group(30, 0, out);
  group(40, d / 2, out);
}

function writeArc(e: SketchArcEntity, params: ResolvedParams, out: string[]): void {
  const cx = evalExpr(e.center[0], params);
  const cy = evalExpr(e.center[1], params);
  const r = evalExpr(e.radius, params);
  const start = evalExpr(e.startAngle, params);
  const end = evalExpr(e.endAngle, params);
  if (cx === undefined || cy === undefined || r === undefined || start === undefined || end === undefined) return;
  const RAD_TO_DEG = 180 / Math.PI;
  group(0, 'ARC', out);
  group(8, '0', out);
  group(10, cx, out);
  group(20, cy, out);
  group(30, 0, out);
  group(40, r, out);
  group(50, start * RAD_TO_DEG, out);
  group(51, end * RAD_TO_DEG, out);
}

function writeEllipse(e: SketchEllipseEntity, params: ResolvedParams, out: string[]): void {
  const cx = evalExpr(e.center[0], params);
  const cy = evalExpr(e.center[1], params);
  const mx = evalExpr(e.majorEnd[0], params);
  const my = evalExpr(e.majorEnd[1], params);
  const minor = evalExpr(e.minorRadius, params);
  if (cx === undefined || cy === undefined || mx === undefined || my === undefined || minor === undefined) return;
  // Major-axis vector relative to centre; rotation is implicit in it.
  const majorVx = mx - cx;
  const majorVy = my - cy;
  const majorR = Math.hypot(majorVx, majorVy);
  if (majorR === 0) return;
  const ratio = minor / majorR;
  group(0, 'ELLIPSE', out);
  group(8, '0', out);
  group(10, cx, out);
  group(20, cy, out);
  group(30, 0, out);
  group(11, majorVx, out);
  group(21, majorVy, out);
  group(31, 0, out);
  group(40, ratio, out);
  group(41, 0, out); // start parameter
  group(42, 2 * Math.PI, out); // end parameter — full ellipse
}

function writeBezier(e: SketchBezierEntity, params: ResolvedParams, out: string[]): void {
  // A cubic bezier is a degree-3 Bézier curve, exported losslessly as a
  // degree-3 DXF SPLINE with its 4 control points (start, cp1, cp2, end).
  const sx = evalExpr(e.start[0], params), sy = evalExpr(e.start[1], params);
  const c1x = evalExpr(e.cp1[0], params), c1y = evalExpr(e.cp1[1], params);
  const c2x = evalExpr(e.cp2[0], params), c2y = evalExpr(e.cp2[1], params);
  const ex = evalExpr(e.end[0], params), ey = evalExpr(e.end[1], params);
  if (
    sx === undefined || sy === undefined || c1x === undefined || c1y === undefined ||
    c2x === undefined || c2y === undefined || ex === undefined || ey === undefined
  ) return;
  group(0, 'SPLINE', out);
  group(8, '0', out);
  group(70, 8, out); // planar
  group(71, 3, out); // degree 3
  group(72, 0, out);
  group(73, 4, out); // 4 control points
  group(74, 0, out);
  for (const [x, y] of [[sx, sy], [c1x, c1y], [c2x, c2y], [ex, ey]] as Array<[number, number]>) {
    group(10, x, out);
    group(20, y, out);
    group(30, 0, out);
  }
}

function writeSpline(e: SketchSplineEntity, params: ResolvedParams, out: string[]): void {
  // Resolve control points; bail if any coordinate is unresolvable.
  const pts: Array<[number, number]> = [];
  for (const [xe, ye] of e.points) {
    const x = evalExpr(xe, params);
    const y = evalExpr(ye, params);
    if (x === undefined || y === undefined) return;
    pts.push([x, y]);
  }
  if (pts.length < 2) return;
  // Degree 3 when there are enough control points, else fall back to a
  // degree matching the control-point count (degree = n-1, clamped ≥ 1).
  // The knot vector is left implicit (group 71 = 0) which DXF readers treat
  // as a default/uniform open spline over the given control points; this is
  // a non-rational, planar control polygon — sufficient for our hand-drawn
  // curves. Group 70 flag bit 8 = planar.
  const degree = Math.min(3, Math.max(1, pts.length - 1));
  group(0, 'SPLINE', out);
  group(8, '0', out);
  group(70, 8, out); // planar
  group(71, degree, out); // degree
  group(72, 0, out); // number of knots (let reader infer)
  group(73, pts.length, out); // number of control points
  group(74, 0, out); // number of fit points
  for (const [x, y] of pts) {
    group(10, x, out);
    group(20, y, out);
    group(30, 0, out);
  }
}

/**
 * Serialize sketch entities to a DXF string.
 *
 * Construction geometry and standalone points are excluded. Coordinates and
 * dimensions are resolved through `params`; any entity whose expressions
 * fail to evaluate is silently skipped (consistent with the rest of the
 * sketch pipeline, which guards on `Result.ok`).
 */
export function sketchToDxf(entities: SketchEntity[], params: ResolvedParams): string {
  const body: string[] = [];

  for (const e of entities) {
    if (e.construction) continue;
    switch (e.type) {
      case 'line':
        writeLine(e, params, body);
        break;
      case 'circle':
        writeCircle(e, params, body);
        break;
      case 'arc':
        writeArc(e, params, body);
        break;
      case 'ellipse':
        writeEllipse(e, params, body);
        break;
      case 'spline':
        writeSpline(e, params, body);
        break;
      case 'bezier':
        writeBezier(e, params, body);
        break;
      case 'point':
        // Reference geometry — never a cut path. Excluded.
        break;
    }
  }

  const out: string[] = [];
  // HEADER section: declare millimetre units.
  group(0, 'SECTION', out);
  group(2, 'HEADER', out);
  group(9, '$INSUNITS', out);
  group(70, 4, out); // 4 = millimetres
  group(0, 'ENDSEC', out);
  // ENTITIES section.
  group(0, 'SECTION', out);
  group(2, 'ENTITIES', out);
  for (const ln of body) out.push(ln);
  group(0, 'ENDSEC', out);
  // End of file.
  group(0, 'EOF', out);

  return out.join('\n') + '\n';
}
