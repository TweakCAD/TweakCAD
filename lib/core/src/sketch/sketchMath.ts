/**
 * Pure geometric primitives used across the sketch editor — intersection
 * routines, projections, parametric tests. No store, no React, no IO; just
 * math on numbers.
 *
 * Lives in `@tweakcad/core/src/sketch/` because the modify-tool
 * primitives (trim / extend / fillet / offset / mirror) consume these
 * helpers and the modify primitives themselves live in core so both the
 * UI dispatch path and the MCP handler path share one implementation.
 *
 * Conventions:
 *   - All coordinates in plane-local mm (the editor's sketch space).
 *   - Line parameters: `t = 0` at start, `t = 1` at end.
 *   - Arc parameters: angles in radians, CCW positive.
 *   - Tolerances chosen so user-scale clicks (~mm) reliably hit, while
 *     numerical noise below 1e-9 doesn't trigger false positives.
 */

// ---- Types ----

/** A 2D point with x,y coords; matches the SketchPoint shape but with no id. */
export interface XY {
  x: number;
  y: number;
}

/** Intersection result: world-space point + parameter on the *first* curve. */
export interface ParametricHit {
  x: number;
  y: number;
  /** Parameter on the source curve (semantics depend on curve type). */
  t: number;
}

// ---- Distance / projection ----

/**
 * Shortest distance from (px,py) to the segment a→b. Clamps to endpoints.
 * Returns Infinity-equivalent (the start-distance) for zero-length segments.
 */
export function distToSegment(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Project (px, py) onto the infinite line through a→b. Returns the parameter
 * `t` (0 = a, 1 = b), or null for zero-length segments. Not clamped.
 */
export function projectOntoLine(
  px: number, py: number,
  a: XY, b: XY,
): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return null;
  return ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
}

// ---- Intersection routines ----

/**
 * Intersect two infinite lines defined by point pairs. Returns the world
 * point plus the parameter `t1` along the first line and `t2` along the
 * second (each 0 at the first defining point, 1 at the second).
 * Returns null when the lines are parallel (within 1e-9).
 */
export function lineLineIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): { x: number; y: number; t1: number; t2: number } | null {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;
  const tNum = (x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4);
  const uNum = (x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2);
  const t = tNum / denom;
  const u = uNum / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t1: t, t2: u };
}

/**
 * Intersect the line segment (x1,y1)–(x2,y2) with the circle (cx,cy,r).
 * Returns 0/1/2 hits, each with the parameter `t` along the segment clamped
 * to [-1e-6, 1+1e-6] tolerance band.
 */
export function lineCircleIntersect(
  x1: number, y1: number, x2: number, y2: number,
  cx: number, cy: number, r: number,
): ParametricHit[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-12) return [];
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const out: ParametricHit[] = [];
  if (t1 >= -1e-6 && t1 <= 1 + 1e-6) out.push({ x: x1 + t1 * dx, y: y1 + t1 * dy, t: t1 });
  if (t2 >= -1e-6 && t2 <= 1 + 1e-6 && Math.abs(t2 - t1) > 1e-9) {
    out.push({ x: x1 + t2 * dx, y: y1 + t2 * dy, t: t2 });
  }
  return out;
}

/**
 * Intersect two circles. Returns 0, 1 (tangent), or 2 intersection points.
 * Tangent case returns a single point. Non-intersecting (too far apart or
 * one inside the other) returns empty.
 */
export function circleCircleIntersect(
  x1: number, y1: number, r1: number,
  x2: number, y2: number, r2: number,
): Array<{ x: number; y: number }> {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return [];
  if (d > r1 + r2 + 1e-9) return [];
  if (d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const xm = x1 + (a * dx) / d;
  const ym = y1 + (a * dy) / d;
  const rx = -dy * (h / d);
  const ry = dx * (h / d);
  if (h < 1e-9) return [{ x: xm, y: ym }];
  return [{ x: xm + rx, y: ym + ry }, { x: xm - rx, y: ym - ry }];
}

// ---- Curve-position tests ----

/**
 * Does the (x, y) point lie inside the arc's angular range, going CCW from
 * start to end? Uses winding direction so reverse-oriented arcs still work.
 */
export function pointOnArc(center: XY, start: XY, end: XY, x: number, y: number): boolean {
  const startAng = Math.atan2(start.y - center.y, start.x - center.x);
  const endAng = Math.atan2(end.y - center.y, end.x - center.x);
  const pAng = Math.atan2(y - center.y, x - center.x);
  let sweep = endAng - startAng;
  while (sweep <= 0) sweep += 2 * Math.PI;
  let d = pAng - startAng;
  while (d < 0) d += 2 * Math.PI;
  while (d > 2 * Math.PI) d -= 2 * Math.PI;
  return d >= -1e-6 && d <= sweep + 1e-6;
}

// ---- Constructions ----

/**
 * Returns the unique circle passing through 3 non-colinear points, or null
 * if they're colinear. Used by the arc-3point tool.
 */
export function circleFrom3Points(
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
): { cx: number; cy: number; r: number } | null {
  const ax = x2 - x1, ay = y2 - y1;
  const bx = x3 - x1, by = y3 - y1;
  const d = 2 * (ax * by - ay * bx);
  if (Math.abs(d) < 1e-9) return null;
  const aLen = ax * ax + ay * ay;
  const bLen = bx * bx + by * by;
  const ux = (by * aLen - ay * bLen) / d;
  const uy = (ax * bLen - bx * aLen) / d;
  const cx = x1 + ux;
  const cy = y1 + uy;
  const r = Math.hypot(ux, uy);
  return { cx, cy, r };
}
