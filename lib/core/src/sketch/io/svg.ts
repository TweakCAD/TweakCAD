/**
 * Sketch → SVG export.
 *
 * EXPORT ONLY. Produces a standalone `<svg>` document sized to the geometry
 * bounds (in millimetres), with native SVG elements for each curve. Import
 * is a separate, later phase.
 *
 * Conventions matched from the sketch model (see
 * `lib/worker/src/featureBuilders/buildSketch.ts` and
 * `lib/core/src/sketch/serialization.ts`):
 *
 *   - Coordinates are mm; each field is an `Expression`, evaluated with
 *     `evaluateExpression(expr, params)` exactly as buildSketch does.
 *   - Arc `startAngle` / `endAngle` are RADIANS, CCW, with a point on the
 *     arc at `center + radius * (cos θ, sin θ)`.
 *   - Ellipse `majorEnd` is the ABSOLUTE major-axis endpoint; major radius
 *     is `|majorEnd - center|` and rotation is
 *     `atan2(majorEnd.y - center.y, majorEnd.x - center.x)`.
 *
 *   - Y FLIP: the sketch plane (and DXF) put +Y up; SVG's Y axis points
 *     DOWN. We flip every Y coordinate to `maxY - y` so the exported drawing
 *     is visually upright. This means CCW sketch angles become CW in the
 *     flipped frame — handled per-element (the arc `sweep-flag` inverts, and
 *     the ellipse rotation negates).
 *
 * Excluded from output (reference geometry, not cut paths):
 *   - entities with `construction: true`
 *   - standalone `point` entities
 *
 * An empty sketch (or one containing only excluded entities) yields a valid
 * SVG with a unit viewBox and no drawing elements.
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

const STROKE = 'black';
const STROKE_WIDTH = 0.1; // mm — thin hairline, typical for laser/CNC SVG.
const MARGIN = 1; // mm border around the geometry bounds.

/** Evaluate an expression, returning `undefined` on any evaluation error. */
function evalExpr(expr: Expression, params: ResolvedParams): number | undefined {
  const r = evaluateExpression(expr, params);
  return r.ok ? r.value : undefined;
}

function fmt(n: number): string {
  return String(n);
}

/**
 * Numeric form of an entity, with all expressions resolved. `null` when any
 * coordinate fails to evaluate (the entity is then skipped, matching the
 * rest of the sketch pipeline).
 */
type ResolvedEntity =
  | { type: 'line'; sx: number; sy: number; ex: number; ey: number }
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'arc'; cx: number; cy: number; r: number; start: number; end: number }
  | { type: 'ellipse'; cx: number; cy: number; majorVx: number; majorVy: number; majorR: number; minor: number }
  | { type: 'spline'; pts: Array<[number, number]> }
  | { type: 'bezier'; sx: number; sy: number; c1x: number; c1y: number; c2x: number; c2y: number; ex: number; ey: number };

function resolveLine(e: SketchLineEntity, p: ResolvedParams): ResolvedEntity | null {
  const sx = evalExpr(e.start[0], p), sy = evalExpr(e.start[1], p);
  const ex = evalExpr(e.end[0], p), ey = evalExpr(e.end[1], p);
  if (sx === undefined || sy === undefined || ex === undefined || ey === undefined) return null;
  return { type: 'line', sx, sy, ex, ey };
}

function resolveCircle(e: SketchCircleEntity, p: ResolvedParams): ResolvedEntity | null {
  const cx = evalExpr(e.center[0], p), cy = evalExpr(e.center[1], p);
  const d = evalExpr(e.diameter, p);
  if (cx === undefined || cy === undefined || d === undefined) return null;
  return { type: 'circle', cx, cy, r: d / 2 };
}

function resolveArc(e: SketchArcEntity, p: ResolvedParams): ResolvedEntity | null {
  const cx = evalExpr(e.center[0], p), cy = evalExpr(e.center[1], p);
  const r = evalExpr(e.radius, p);
  const start = evalExpr(e.startAngle, p), end = evalExpr(e.endAngle, p);
  if (cx === undefined || cy === undefined || r === undefined || start === undefined || end === undefined) return null;
  return { type: 'arc', cx, cy, r, start, end };
}

function resolveEllipse(e: SketchEllipseEntity, p: ResolvedParams): ResolvedEntity | null {
  const cx = evalExpr(e.center[0], p), cy = evalExpr(e.center[1], p);
  const mx = evalExpr(e.majorEnd[0], p), my = evalExpr(e.majorEnd[1], p);
  const minor = evalExpr(e.minorRadius, p);
  if (cx === undefined || cy === undefined || mx === undefined || my === undefined || minor === undefined) return null;
  const majorVx = mx - cx, majorVy = my - cy;
  const majorR = Math.hypot(majorVx, majorVy);
  if (majorR === 0) return null;
  return { type: 'ellipse', cx, cy, majorVx, majorVy, majorR, minor };
}

function resolveSpline(e: SketchSplineEntity, p: ResolvedParams): ResolvedEntity | null {
  const pts: Array<[number, number]> = [];
  for (const [xe, ye] of e.points) {
    const x = evalExpr(xe, p), y = evalExpr(ye, p);
    if (x === undefined || y === undefined) return null;
    pts.push([x, y]);
  }
  if (pts.length < 2) return null;
  return { type: 'spline', pts };
}

function resolveBezier(e: SketchBezierEntity, p: ResolvedParams): ResolvedEntity | null {
  const sx = evalExpr(e.start[0], p), sy = evalExpr(e.start[1], p);
  const c1x = evalExpr(e.cp1[0], p), c1y = evalExpr(e.cp1[1], p);
  const c2x = evalExpr(e.cp2[0], p), c2y = evalExpr(e.cp2[1], p);
  const ex = evalExpr(e.end[0], p), ey = evalExpr(e.end[1], p);
  if (
    sx === undefined || sy === undefined || c1x === undefined || c1y === undefined ||
    c2x === undefined || c2y === undefined || ex === undefined || ey === undefined
  ) return null;
  return { type: 'bezier', sx, sy, c1x, c1y, c2x, c2y, ex, ey };
}

/** Accumulate the axis-aligned bounds of a resolved entity into [min,max]. */
function expandBounds(e: ResolvedEntity, b: { minX: number; minY: number; maxX: number; maxY: number }): void {
  const add = (x: number, y: number) => {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  };
  switch (e.type) {
    case 'line':
      add(e.sx, e.sy);
      add(e.ex, e.ey);
      break;
    case 'circle':
    case 'arc':
      // Use the full circle bounds — a safe (if slightly loose) box for arcs.
      add(e.cx - e.r, e.cy - e.r);
      add(e.cx + e.r, e.cy + e.r);
      break;
    case 'ellipse': {
      // Bounding box of a rotated ellipse: half-extents are
      // sqrt((a·cosθ)² + (b·sinθ)²) in X and sqrt((a·sinθ)² + (b·cosθ)²) in Y.
      const a = e.majorR, bb = e.minor;
      const ux = e.majorVx / a, uy = e.majorVy / a; // unit major axis
      const hx = Math.hypot(a * ux, bb * -uy);
      const hy = Math.hypot(a * uy, bb * ux);
      add(e.cx - hx, e.cy - hy);
      add(e.cx + hx, e.cy + hy);
      break;
    }
    case 'spline':
      for (const [x, y] of e.pts) add(x, y);
      break;
    case 'bezier':
      // Control hull bounds the curve (loose but safe).
      add(e.sx, e.sy);
      add(e.c1x, e.c1y);
      add(e.c2x, e.c2y);
      add(e.ex, e.ey);
      break;
  }
}

/**
 * Serialize sketch entities to an SVG string.
 *
 * Construction geometry and standalone points are excluded. Y is flipped so
 * the drawing is upright in SVG's Y-down coordinate system.
 */
export function sketchToSvg(entities: SketchEntity[], params: ResolvedParams): string {
  const resolved: ResolvedEntity[] = [];
  for (const e of entities) {
    if (e.construction) continue;
    let r: ResolvedEntity | null = null;
    switch (e.type) {
      case 'line': r = resolveLine(e, params); break;
      case 'circle': r = resolveCircle(e, params); break;
      case 'arc': r = resolveArc(e, params); break;
      case 'ellipse': r = resolveEllipse(e, params); break;
      case 'spline': r = resolveSpline(e, params); break;
      case 'bezier': r = resolveBezier(e, params); break;
      case 'point': break; // reference geometry — excluded
    }
    if (r) resolved.push(r);
  }

  if (resolved.length === 0) {
    // Valid empty document with a unit viewBox.
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="1mm" height="1mm" viewBox="0 0 1 1"></svg>\n'
    );
  }

  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const e of resolved) expandBounds(e, b);

  const minX = b.minX - MARGIN;
  const maxX = b.maxX + MARGIN;
  const maxY = b.maxY + MARGIN;
  const width = maxX - minX;
  const height = maxY - (b.minY - MARGIN);

  // Y flip: sketch +Y is up, SVG +Y is down. Map sketch-Y → (maxY - y).
  // With maxY the top of the (margin-padded) bounds, this sends the whole
  // drawing into [0, height]: sketch y=maxY → 0 (top), y=minY → height
  // (bottom). X is unchanged and stays in [minX, maxX]. The viewBox Y
  // origin is therefore 0, not minY.
  const fy = (y: number): number => maxY - y;

  const elements: string[] = [];

  for (const e of resolved) {
    switch (e.type) {
      case 'line':
        elements.push(
          `  <line x1="${fmt(e.sx)}" y1="${fmt(fy(e.sy))}" x2="${fmt(e.ex)}" y2="${fmt(fy(e.ey))}" />`,
        );
        break;
      case 'circle':
        elements.push(
          `  <circle cx="${fmt(e.cx)}" cy="${fmt(fy(e.cy))}" r="${fmt(e.r)}" />`,
        );
        break;
      case 'arc': {
        // Endpoints from CCW angles in sketch space, then Y-flipped.
        const x1 = e.cx + e.r * Math.cos(e.start);
        const y1 = e.cy + e.r * Math.sin(e.start);
        const x2 = e.cx + e.r * Math.cos(e.end);
        const y2 = e.cy + e.r * Math.sin(e.end);
        let sweep = e.end - e.start;
        // Normalize the sweep into (0, 2π] so the large-arc flag is correct.
        while (sweep <= 0) sweep += 2 * Math.PI;
        while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
        const largeArc = sweep > Math.PI ? 1 : 0;
        // CCW in sketch space becomes CW after the Y flip, so sweep-flag = 0
        // (SVG sweep-flag 1 = positive-angle/CW in its Y-down frame).
        const sweepFlag = 0;
        elements.push(
          `  <path d="M ${fmt(x1)} ${fmt(fy(y1))} A ${fmt(e.r)} ${fmt(e.r)} 0 ${largeArc} ${sweepFlag} ${fmt(x2)} ${fmt(fy(y2))}" />`,
        );
        break;
      }
      case 'ellipse': {
        // Rotation in sketch space (CCW); negate after the Y flip.
        const rot = Math.atan2(e.majorVy, e.majorVx);
        const deg = (-rot * 180) / Math.PI;
        elements.push(
          `  <ellipse cx="${fmt(e.cx)}" cy="${fmt(fy(e.cy))}" rx="${fmt(e.majorR)}" ry="${fmt(e.minor)}" transform="rotate(${fmt(deg)} ${fmt(e.cx)} ${fmt(fy(e.cy))})" />`,
        );
        break;
      }
      case 'spline': {
        // Render as a polyline through the control points (Y-flipped). A
        // smooth Bezier fit is a future refinement; the control polygon is a
        // faithful, lossless representation of what we store.
        const pts = e.pts.map(([x, y]) => `${fmt(x)},${fmt(fy(y))}`).join(' ');
        elements.push(`  <polyline points="${pts}" fill="none" />`);
        break;
      }
      case 'bezier': {
        // Native cubic path — control points just Y-flip (bezier is affine).
        elements.push(
          `  <path d="M ${fmt(e.sx)} ${fmt(fy(e.sy))} C ${fmt(e.c1x)} ${fmt(fy(e.c1y))} ${fmt(e.c2x)} ${fmt(fy(e.c2y))} ${fmt(e.ex)} ${fmt(fy(e.ey))}" />`,
        );
        break;
      }
    }
  }

  const header =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmt(width)}mm" height="${fmt(height)}mm" ` +
    `viewBox="${fmt(minX)} 0 ${fmt(width)} ${fmt(height)}" ` +
    `fill="none" stroke="${STROKE}" stroke-width="${fmt(STROKE_WIDTH)}">`;

  return header + '\n' + elements.join('\n') + '\n</svg>\n';
}
