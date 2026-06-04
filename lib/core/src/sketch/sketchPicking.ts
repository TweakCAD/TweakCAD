/**
 * Hit-testing for sketch geometry. Given an (x, y) point in sketch space,
 * returns the topmost geometry under it (or null). One per-type picker, all
 * sharing the same tolerance band so user clicks feel consistent across
 * primitive types.
 *
 * Pure function over an EditorState (just the geometries + points maps).
 * Lives in core so the same picker serves both the UI tool dispatcher in
 * the web app and the `sketch_pick_geometry` MCP tool that callers use
 * before issuing trim/extend/fillet/offset/mirror.
 */

import type {
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from './types.ts';
import type { EditorState } from './operations.ts';
import { distToSegment } from './sketchMath.ts';

/**
 * Generous tolerance because clicks are freehand. Matches the scene
 * manager's select-mode hover tolerance so picked == hovered when the user
 * fires a tool.
 */
const PICK_TOLERANCE = 2.0;

/**
 * Return the geometry id under (x, y), or null. First-match wins; iteration
 * order is the geometries Map's insertion order, so newer geometry takes
 * precedence over older when overlapping.
 */
export function pickGeometryAt(
  state: Pick<EditorState, 'geometries' | 'points'>,
  x: number, y: number,
): SketchGeometryId | null {
  for (const [gid, geom] of state.geometries) {
    if (hits(geom, state.points, x, y)) return gid;
  }
  return null;
}

// ---- Per-type hit-tests ----

function hits(
  geom: SketchGeometry,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  x: number, y: number,
): boolean {
  switch (geom.type) {
    case 'line':    return hitsLine(geom, points, x, y);
    case 'circle':  return hitsCircle(geom, points, x, y);
    case 'arc':     return hitsCircle(geom, points, x, y); // share radius test
    case 'ellipse': return hitsEllipse(geom, points, x, y);
    // 'spline' and 'point' aren't supported for trim/modify picks today —
    // splines need a polyline expansion; points are picked through the
    // point-snap path instead. There are no `slot` / `polygon` editor
    // geometries (decomposed at draw time into lines + arcs).
    default: return false;
  }
}

function hitsLine(
  geom: Extract<SketchGeometry, { type: 'line' }>,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  x: number, y: number,
): boolean {
  const a = points.get(geom.startId);
  const b = points.get(geom.endId);
  if (!a || !b) return false;
  return distToSegment(x, y, a.x, a.y, b.x, b.y) <= PICK_TOLERANCE;
}

function hitsCircle(
  geom: Extract<SketchGeometry, { type: 'circle' | 'arc' }>,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  x: number, y: number,
): boolean {
  const c = points.get(geom.centerId);
  if (!c) return false;
  const d = Math.hypot(x - c.x, y - c.y);
  return Math.abs(d - geom.radius) <= PICK_TOLERANCE;
}

function hitsEllipse(
  geom: Extract<SketchGeometry, { type: 'ellipse' }>,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  x: number, y: number,
): boolean {
  const c = points.get(geom.centerId);
  const m = points.get(geom.majorId);
  if (!c || !m) return false;
  const dx = m.x - c.x, dy = m.y - c.y;
  const A = Math.hypot(dx, dy);
  const B = geom.minorRadius;
  if (A < 1e-6 || B < 1e-6) return false;
  const ang = Math.atan2(dy, dx);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // Transform (x,y) into ellipse-local coords (rotate by -ang, translate to
  // center), then test the normalized magnitude. Multiplying by min(A,B)
  // approximates the normal distance and matches PICK_TOLERANCE's mm units.
  const lx =  (x - c.x) * ca + (y - c.y) * sa;
  const ly = -(x - c.x) * sa + (y - c.y) * ca;
  const e = Math.sqrt((lx / A) * (lx / A) + (ly / B) * (ly / B));
  return Math.abs(e - 1) * Math.min(A, B) <= PICK_TOLERANCE;
}
