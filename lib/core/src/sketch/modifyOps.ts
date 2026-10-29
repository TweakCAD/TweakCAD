/**
 * Sketch modify operations — pure-function primitives for trim, extend,
 * fillet, offset, and mirror. The editor-side modify-tool math lives in
 * core so both the UI dispatch path and the MCP command handler path can
 * call one shared implementation, the same way the create + constrain +
 * manipulate vocabulary is shared.
 *
 * Each function takes an `EditorState` and returns a new one (or null
 * if the operation is a no-op / target missing). Pure — no closures
 * over editor stores, no React, no global counters, following the
 * `operations.ts` pattern.
 *
 * **Modify-vs-create semantics:** modify operations DELETE one or more
 * geometries and ADD their replacement pieces atomically (one undo
 * entry via the bus). The deleted points get garbage-collected if no
 * surviving geometry references them, and constraints that named the
 * deleted geometry are cascaded by `reapDanglingReferences` — the op
 * returns solver-ready state, the handler doesn't clean up after it.
 * `trimAt` is the only op here that deletes; extend, fillet, offset and
 * mirror add or move geometry.
 */

import type {
  SketchGeometry,
  SketchGeometryId,
  SketchGeometryInput,
  SketchPoint,
  SketchPointId,
} from './types.ts';
import { sketchGeometryId, sketchPointId } from './types.ts';
import type { EditorState } from './operations.ts';
import { reapDanglingReferences } from './operations.ts';
import { generateId } from '../ids.ts';
import {
  lineLineIntersect,
  lineCircleIntersect,
  circleCircleIntersect,
  projectOntoLine,
  pointOnArc,
} from './sketchMath.ts';

// ---- Internal helpers ----------------------------------------------------

/** Build a fresh, mutable working copy of the editor state's three maps. */
function makeWorking(state: EditorState): {
  points: Map<SketchPointId, SketchPoint>;
  geometries: Map<SketchGeometryId, SketchGeometry>;
} {
  return {
    points: new Map(state.points),
    geometries: new Map(state.geometries),
  };
}

function addPointMut(
  points: Map<SketchPointId, SketchPoint>,
  x: number, y: number,
): SketchPointId {
  const id = sketchPointId(generateId('pt'));
  points.set(id, { id, x, y, fixed: false });
  return id;
}

function addGeometryMut(
  geometries: Map<SketchGeometryId, SketchGeometry>,
  geom: SketchGeometryInput,
): SketchGeometryId {
  const id = sketchGeometryId(generateId('geo'));
  geometries.set(id, { ...geom, id } as SketchGeometry);
  return id;
}

/**
 * GC: remove any point in `pointsToCheck` that no surviving geometry
 * references. Called after a modify op deletes its source geometry so
 * we don't leak the source's endpoints when they're no longer used.
 * Constraints aren't consulted — over-conservative is fine; orphan
 * points referenced by constraints stay alive.
 */
function gcPoints(
  points: Map<SketchPointId, SketchPoint>,
  geometries: Map<SketchGeometryId, SketchGeometry>,
  constraints: ReadonlyMap<unknown, { pointA?: SketchPointId; pointB?: SketchPointId; pointId?: SketchPointId }>,
  pointsToCheck: ReadonlySet<SketchPointId>,
): void {
  const inUse = new Set<SketchPointId>();
  for (const g of geometries.values()) {
    for (const id of geomPointIds(g)) inUse.add(id);
  }
  for (const c of constraints.values() as Iterable<{ pointA?: SketchPointId; pointB?: SketchPointId; pointId?: SketchPointId }>) {
    if (c.pointA) inUse.add(c.pointA);
    if (c.pointB) inUse.add(c.pointB);
    if (c.pointId) inUse.add(c.pointId);
  }
  for (const id of pointsToCheck) {
    if (!inUse.has(id)) points.delete(id);
  }
}

function geomPointIds(geom: SketchGeometry): SketchPointId[] {
  switch (geom.type) {
    case 'line':    return [geom.startId, geom.endId];
    case 'circle':  return [geom.centerId];
    case 'arc':     return [geom.centerId, geom.startId, geom.endId];
    case 'ellipse': return [geom.centerId, geom.majorId];
    case 'spline':  return [...geom.pointIds];
    case 'bezier':  return [geom.startId, geom.cp1Id, geom.cp2Id, geom.endId];
    case 'point':   return [geom.pointId];
  }
}

// ---- Trim ----------------------------------------------------------------

/**
 * Trim the picked geometry at a cursor location. Finds intersections
 * with every other curve, identifies the sub-segment containing
 * `cursor`, and replaces the original with the surviving sub-pieces.
 *
 * - Line: split into ≤2 surviving sub-lines.
 * - Arc: split into ≤2 surviving sub-arcs.
 * - Circle: 2+ intersections → arc going CCW from prevCW to nextCCW
 *   (the side NOT under the cursor). 0–1 intersections → whole-delete.
 *
 * Returns the new state. Returns null if the target is gone or the
 * cursor can't be projected onto the curve.
 */
export function trimAt(
  state: EditorState,
  targetId: SketchGeometryId,
  cursor: readonly [number, number],
): EditorState | null {
  const trimmed = trimGeometry(state, targetId, cursor);
  // The per-kind helpers below delete geometry across ten early-return
  // paths and none of them touch `state.constraints`. Cascading once
  // here, off the before/after diff, is what keeps a constraint from
  // outliving the geometry it names.
  return trimmed === null ? null : reapDanglingReferences(state, trimmed);
}

function trimGeometry(
  state: EditorState,
  targetId: SketchGeometryId,
  cursor: readonly [number, number],
): EditorState | null {
  const target = state.geometries.get(targetId);
  if (!target) return null;
  if (target.type === 'line')   return trimLine(state, targetId, target, cursor[0], cursor[1]);
  if (target.type === 'arc')    return trimArc(state, targetId, target, cursor[0], cursor[1]);
  if (target.type === 'circle') return trimCircle(state, targetId, target, cursor[0], cursor[1]);
  // Ellipse/spline/point trim isn't supported (explode-and-trim is a
  // separate workflow). Whole-delete instead.
  const next = makeWorking(state);
  const removedRefs = new Set(geomPointIds(target));
  next.geometries.delete(targetId);
  gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
  return { ...state, points: next.points, geometries: next.geometries };
}

function trimLine(
  state: EditorState,
  targetId: SketchGeometryId,
  target: Extract<SketchGeometry, { type: 'line' }>,
  cursorX: number, cursorY: number,
): EditorState | null {
  const a = state.points.get(target.startId);
  const b = state.points.get(target.endId);
  if (!a || !b) return null;

  const cursorT = projectOntoLine(cursorX, cursorY, a, b);
  if (cursorT === null) return null;

  const hits: Array<{ x: number; y: number; t: number }> = [];
  for (const [otherId, other] of state.geometries) {
    if (otherId === targetId) continue;
    hits.push(...intersectLineWith(a, b, other, state.points));
  }
  const inner = hits.filter((h) => h.t > 1e-6 && h.t < 1 - 1e-6).sort((p, q) => p.t - q.t);

  const next = makeWorking(state);
  const removedRefs = new Set([target.startId, target.endId]);

  if (inner.length === 0) {
    next.geometries.delete(targetId);
    gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
    return { ...state, points: next.points, geometries: next.geometries };
  }

  let leftT = 0, rightT = 1;
  let leftPt: { x: number; y: number } = { x: a.x, y: a.y };
  let rightPt: { x: number; y: number } = { x: b.x, y: b.y };
  let bracketed = false;
  for (const h of inner) {
    if (h.t < cursorT) { leftT = h.t; leftPt = { x: h.x, y: h.y }; bracketed = true; }
    else                { rightT = h.t; rightPt = { x: h.x, y: h.y }; bracketed = true; break; }
  }
  if (!bracketed) {
    next.geometries.delete(targetId);
    gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
    return { ...state, points: next.points, geometries: next.geometries };
  }

  const c = target.construction;
  next.geometries.delete(targetId);
  if (leftT > 1e-6) {
    const newEnd = addPointMut(next.points, leftPt.x, leftPt.y);
    addGeometryMut(next.geometries, { type: 'line', startId: target.startId, endId: newEnd, construction: c });
    removedRefs.delete(target.startId); // surviving piece keeps the start ref
  }
  if (rightT < 1 - 1e-6) {
    const newStart = addPointMut(next.points, rightPt.x, rightPt.y);
    addGeometryMut(next.geometries, { type: 'line', startId: newStart, endId: target.endId, construction: c });
    removedRefs.delete(target.endId);
  }
  gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
  return { ...state, points: next.points, geometries: next.geometries };
}

function trimArc(
  state: EditorState,
  targetId: SketchGeometryId,
  target: Extract<SketchGeometry, { type: 'arc' }>,
  cursorX: number, cursorY: number,
): EditorState | null {
  const center = state.points.get(target.centerId);
  const startPt = state.points.get(target.startId);
  const endPt = state.points.get(target.endId);
  if (!center || !startPt || !endPt) return null;

  const r = Math.hypot(startPt.x - center.x, startPt.y - center.y);
  const startAng = Math.atan2(startPt.y - center.y, startPt.x - center.x);
  const endAng = Math.atan2(endPt.y - center.y, endPt.x - center.x);
  let sweep = endAng - startAng;
  while (sweep <= 0) sweep += 2 * Math.PI;

  const toParam = (ang: number): number => {
    let d = ang - startAng;
    while (d < 0) d += 2 * Math.PI;
    while (d > 2 * Math.PI) d -= 2 * Math.PI;
    return d;
  };

  const cursorAng = Math.atan2(cursorY - center.y, cursorX - center.x);
  const cursorT = toParam(cursorAng);

  const next = makeWorking(state);
  const removedRefs = new Set([target.startId, target.endId]);

  if (cursorT > sweep) {
    next.geometries.delete(targetId);
    gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
    return { ...state, points: next.points, geometries: next.geometries };
  }

  const hits: Array<{ x: number; y: number; t: number }> = [];
  for (const [otherId, other] of state.geometries) {
    if (otherId === targetId) continue;
    const others = intersectCircleWith(center, r, other, state.points);
    for (const h of others) {
      const t = toParam(Math.atan2(h.y - center.y, h.x - center.x));
      if (t > 1e-6 && t < sweep - 1e-6) hits.push({ x: h.x, y: h.y, t });
    }
  }
  hits.sort((p, q) => p.t - q.t);

  if (hits.length === 0) {
    next.geometries.delete(targetId);
    gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
    return { ...state, points: next.points, geometries: next.geometries };
  }

  let leftT = 0, rightT = sweep;
  let leftPt: { x: number; y: number } = { x: startPt.x, y: startPt.y };
  let rightPt: { x: number; y: number } = { x: endPt.x, y: endPt.y };
  for (const h of hits) {
    if (h.t < cursorT) { leftT = h.t; leftPt = { x: h.x, y: h.y }; }
    else                { rightT = h.t; rightPt = { x: h.x, y: h.y }; break; }
  }

  const c = target.construction;
  next.geometries.delete(targetId);
  if (leftT > 1e-6) {
    const newEnd = addPointMut(next.points, leftPt.x, leftPt.y);
    addGeometryMut(next.geometries, { type: 'arc', centerId: target.centerId, startId: target.startId, endId: newEnd, radius: r, construction: c });
    removedRefs.delete(target.startId);
  }
  if (rightT < sweep - 1e-6) {
    const newStart = addPointMut(next.points, rightPt.x, rightPt.y);
    addGeometryMut(next.geometries, { type: 'arc', centerId: target.centerId, startId: newStart, endId: target.endId, radius: r, construction: c });
    removedRefs.delete(target.endId);
  }
  // The arc's center is also referenced by the surviving sub-arcs (if any).
  if (leftT > 1e-6 || rightT < sweep - 1e-6) {
    removedRefs.delete(target.centerId);
  }
  gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
  return { ...state, points: next.points, geometries: next.geometries };
}

function trimCircle(
  state: EditorState,
  targetId: SketchGeometryId,
  target: Extract<SketchGeometry, { type: 'circle' }>,
  cursorX: number, cursorY: number,
): EditorState | null {
  const center = state.points.get(target.centerId);
  if (!center) return null;
  const r = target.radius;
  const cursorAng = Math.atan2(cursorY - center.y, cursorX - center.x);

  const raw: Array<{ x: number; y: number; ang: number }> = [];
  for (const [otherId, other] of state.geometries) {
    if (otherId === targetId) continue;
    const others = intersectCircleWith(center, r, other, state.points);
    for (const h of others) raw.push({ ...h, ang: Math.atan2(h.y - center.y, h.x - center.x) });
  }

  const next = makeWorking(state);
  // The circle's center is shared with no other geometry by default;
  // we keep it for surviving pieces or GC it via gcPoints.
  const removedRefs = new Set([target.centerId]);

  if (raw.length < 2) {
    next.geometries.delete(targetId);
    gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
    return { ...state, points: next.points, geometries: next.geometries };
  }

  let nextCCW: { x: number; y: number; ang: number } | null = null;
  let prevCW:  { x: number; y: number; ang: number } | null = null;
  let bestCCW = Infinity, bestCW = Infinity;
  for (const h of raw) {
    let dCCW = h.ang - cursorAng; while (dCCW <= 0) dCCW += 2 * Math.PI;
    let dCW  = cursorAng - h.ang; while (dCW  <= 0) dCW  += 2 * Math.PI;
    if (dCCW < bestCCW) { bestCCW = dCCW; nextCCW = h; }
    if (dCW  < bestCW)  { bestCW  = dCW;  prevCW  = h; }
  }
  if (!nextCCW || !prevCW) {
    next.geometries.delete(targetId);
    gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
    return { ...state, points: next.points, geometries: next.geometries };
  }

  const c = target.construction;
  next.geometries.delete(targetId);
  const startId = addPointMut(next.points, nextCCW.x, nextCCW.y);
  const endId = addPointMut(next.points, prevCW.x, prevCW.y);
  addGeometryMut(next.geometries, {
    type: 'arc',
    centerId: target.centerId,
    startId, endId,
    radius: r,
    construction: c,
  });
  removedRefs.delete(target.centerId); // surviving arc keeps the center
  gcPoints(next.points, next.geometries, state.constraints as never, removedRefs);
  return { ...state, points: next.points, geometries: next.geometries };
}

// ---- Extend --------------------------------------------------------------

/**
 * Extend the picked LINE until it reaches the nearest other line's
 * infinite extension. Picks the closer of the two ends to push out.
 * Returns the new state, or null if the target is not a
 * line or no extension target exists.
 */
export function extendAt(
  state: EditorState,
  targetId: SketchGeometryId,
): EditorState | null {
  const target = state.geometries.get(targetId);
  if (!target || target.type !== 'line') return null;

  const a = state.points.get(target.startId);
  const b = state.points.get(target.endId);
  if (!a || !b) return null;

  let best: { px: number; py: number; param: number } | null = null;
  for (const [gid, geom] of state.geometries) {
    if (gid === targetId || geom.type !== 'line') continue;
    const c = state.points.get(geom.startId);
    const d = state.points.get(geom.endId);
    if (!c || !d) continue;
    const hit = lineLineIntersect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
    if (!hit) continue;
    if (hit.t1 > 1 || hit.t1 < 0) {
      const param = hit.t1;
      if (!best || Math.abs(param - 1) < Math.abs(best.param - 1)) {
        best = { px: hit.x, py: hit.y, param };
      }
    }
  }
  if (!best) return null;

  const next = makeWorking(state);
  const idToMove = best.param > 1 ? target.endId : target.startId;
  const existing = next.points.get(idToMove);
  if (!existing) return null;
  next.points.set(idToMove, { ...existing, x: best.px, y: best.py });
  return { ...state, points: next.points, geometries: next.geometries };
}

// ---- Fillet --------------------------------------------------------------

/**
 * Insert a fillet (rounded corner) between two lines that share — or
 * nearly share — an endpoint. The shared corner is determined by
 * finding the closest pair of endpoints. The two lines' shared
 * endpoints are moved inward to the fillet's tangent points, and a
 * new arc is added on the bisector. Returns the new state, or null
 * if either input isn't a line / corner can't be resolved / fillet
 * would be degenerate.
 *
 * The corner arrives in one of two shapes and both have to work:
 *
 *  - **One shared point.** `findOrCreatePoint` merged the endpoints when
 *    the second line was drawn at the first one's end. A single point
 *    can't sit at both tangent points, so the corner is split and line
 *    B is repointed at a fresh endpoint.
 *  - **Two points plus a `coincident`.** Chain mode (`SketchDrawLine`
 *    with `chainFrom`) keeps the endpoints distinct and ties them
 *    together with a removable constraint. The fillet separates them by
 *    design, so that constraint goes — left in place, the next solve
 *    pulls them back together and the corner closes over the arc.
 *
 * The arc keeps the lines' own endpoint ids rather than fresh points at
 * the same coordinates, so dragging a leg carries the fillet with it.
 * Tangency is geometric only: no `tangent` constraint is added, so a
 * later drag of the far end slides the leg off the arc. Making the
 * fillet parametric is a separate piece of work.
 *
 * Default radius (when caller passes undefined): `min(10, shorter-leg / 5)`.
 */
export function filletBetweenLines(
  state: EditorState,
  geomAId: SketchGeometryId,
  geomBId: SketchGeometryId,
  radius?: number,
): EditorState | null {
  const a = state.geometries.get(geomAId);
  const b = state.geometries.get(geomBId);
  if (!a || a.type !== 'line' || !b || b.type !== 'line') return null;

  const aStart = state.points.get(a.startId);
  const aEnd = state.points.get(a.endId);
  const bStart = state.points.get(b.startId);
  const bEnd = state.points.get(b.endId);
  if (!aStart || !aEnd || !bStart || !bEnd) return null;

  type EndRef = {
    pt: SketchPoint;
    otherPt: SketchPoint;
    pointId: SketchPointId;
    /** Which field of the line holds `pointId` — needed to repoint it. */
    which: 'start' | 'end';
  };
  const aS: EndRef = { pt: aStart, otherPt: aEnd, pointId: a.startId, which: 'start' };
  const aE: EndRef = { pt: aEnd, otherPt: aStart, pointId: a.endId, which: 'end' };
  const bS: EndRef = { pt: bStart, otherPt: bEnd, pointId: b.startId, which: 'start' };
  const bE: EndRef = { pt: bEnd, otherPt: bStart, pointId: b.endId, which: 'end' };

  // Parallel legs have no corner to round. Tested on the lines' own
  // directions, because the apex-angle check further down can't see it:
  // for two disjoint parallels the closest-pair midpoint lands off both
  // lines, and the vectors from there to the far ends do form an angle
  // (~28° for two 10 mm lines 5 mm apart), which yields a fillet in
  // mid-air instead of a rejection.
  const dirA = { x: aEnd.x - aStart.x, y: aEnd.y - aStart.y };
  const dirB = { x: bEnd.x - bStart.x, y: bEnd.y - bStart.y };
  const dirALen = Math.hypot(dirA.x, dirA.y);
  const dirBLen = Math.hypot(dirB.x, dirB.y);
  if (dirALen < 1e-9 || dirBLen < 1e-9) return null;
  const sinBetween = (dirA.x * dirB.y - dirA.y * dirB.x) / (dirALen * dirBLen);
  if (Math.abs(sinBetween) < 0.01) return null;

  let best: { aRef: EndRef; bRef: EndRef; dist: number } | null = null;
  for (const ar of [aS, aE]) {
    for (const br of [bS, bE]) {
      const d = Math.hypot(ar.pt.x - br.pt.x, ar.pt.y - br.pt.y);
      if (!best || d < best.dist) best = { aRef: ar, bRef: br, dist: d };
    }
  }
  if (!best) return null;

  const cornerX = (best.aRef.pt.x + best.bRef.pt.x) / 2;
  const cornerY = (best.aRef.pt.y + best.bRef.pt.y) / 2;

  const va = { x: best.aRef.otherPt.x - cornerX, y: best.aRef.otherPt.y - cornerY };
  const vb = { x: best.bRef.otherPt.x - cornerX, y: best.bRef.otherPt.y - cornerY };
  const lenA = Math.hypot(va.x, va.y);
  const lenB = Math.hypot(vb.x, vb.y);
  if (lenA < 0.01 || lenB < 0.01) return null;
  const ua = { x: va.x / lenA, y: va.y / lenA };
  const ub = { x: vb.x / lenB, y: vb.y / lenB };

  const r = radius ?? Math.min(10, Math.min(lenA, lenB) / 5);

  const dot = ua.x * ub.x + ua.y * ub.y;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (angle < 0.01 || angle > Math.PI - 0.01) return null;
  const d = r / Math.tan(angle / 2);

  const t1x = cornerX + ua.x * d;
  const t1y = cornerY + ua.y * d;
  const t2x = cornerX + ub.x * d;
  const t2y = cornerY + ub.y * d;

  const bx = (ua.x + ub.x);
  const by = (ua.y + ub.y);
  const bLen = Math.hypot(bx, by) || 1;
  const bisector = { x: bx / bLen, y: by / bLen };
  const centerDist = r / Math.sin(angle / 2);
  const cx = cornerX + bisector.x * centerDist;
  const cy = cornerY + bisector.y * centerDist;

  const next = makeWorking(state);
  // Move existing corner endpoints to the tangent points.
  const aEx = next.points.get(best.aRef.pointId);
  const bEx = next.points.get(best.bRef.pointId);
  if (!aEx || !bEx) return null;
  next.points.set(best.aRef.pointId, { ...aEx, x: t1x, y: t1y });

  // Line A keeps the corner point id. Line B needs one of its own when
  // the corner is a single merged point — the two tangent points are in
  // different places, and the second write would otherwise just drag
  // line A's endpoint to line B's tangent point and tilt it.
  let bPointId = best.bRef.pointId;
  if (bPointId === best.aRef.pointId) {
    bPointId = addPointMut(next.points, t2x, t2y);
    const bLine = next.geometries.get(geomBId);
    if (!bLine || bLine.type !== 'line') return null;
    next.geometries.set(geomBId, best.bRef.which === 'start'
      ? { ...bLine, startId: bPointId }
      : { ...bLine, endId: bPointId });
  } else {
    next.points.set(bPointId, { ...bEx, x: t2x, y: t2y });
  }

  const centerId = addPointMut(next.points, cx, cy);
  // Arcs always wind CCW from start to end, so the tangent points can't
  // go out in pick order: half the time that spans the reflex arc and
  // the user gets a 270° gouge instead of the 90° round.
  let sweep = Math.atan2(t2y - cy, t2x - cx) - Math.atan2(t1y - cy, t1x - cx);
  while (sweep <= 0) sweep += 2 * Math.PI;
  const aFirst = sweep <= Math.PI;
  addGeometryMut(next.geometries, {
    type: 'arc',
    centerId,
    startId: aFirst ? best.aRef.pointId : bPointId,
    endId: aFirst ? bPointId : best.aRef.pointId,
    radius: r,
    construction: false,
  });

  // The chain coincident that held the corner together describes a
  // corner that no longer exists.
  const constraints = new Map(state.constraints);
  for (const [cid, c] of constraints) {
    if (c.type !== 'coincident') continue;
    const joinsCorner =
      (c.pointA === best.aRef.pointId && c.pointB === best.bRef.pointId) ||
      (c.pointB === best.aRef.pointId && c.pointA === best.bRef.pointId);
    if (joinsCorner) constraints.delete(cid);
  }
  return { ...state, points: next.points, geometries: next.geometries, constraints };
}

// ---- Offset --------------------------------------------------------------

/**
 * Offset a line or circle by `distance` mm, picking the side based on
 * which side of the source the cursor sits. Adds the offset as new
 * geometry (the original is untouched). Returns the new state, or
 * null if the target isn't an offsettable curve / coords degenerate.
 */
export function offsetCurveAt(
  state: EditorState,
  targetId: SketchGeometryId,
  distance: number,
  cursor: readonly [number, number],
  construction: boolean,
): EditorState | null {
  const geom = state.geometries.get(targetId);
  if (!geom) return null;
  const next = makeWorking(state);

  if (geom.type === 'line') {
    const a = state.points.get(geom.startId);
    const b = state.points.get(geom.endId);
    if (!a || !b) return null;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return null;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const side = Math.sign((cursor[0] - a.x) * nx + (cursor[1] - a.y) * ny) || 1;
    const d = distance * side;
    const np1 = addPointMut(next.points, a.x + nx * d, a.y + ny * d);
    const np2 = addPointMut(next.points, b.x + nx * d, b.y + ny * d);
    addGeometryMut(next.geometries, { type: 'line', startId: np1, endId: np2, construction });
    return { ...state, points: next.points, geometries: next.geometries };
  }

  if (geom.type === 'circle') {
    const c = state.points.get(geom.centerId);
    if (!c) return null;
    const dist = Math.hypot(cursor[0] - c.x, cursor[1] - c.y);
    const newR = dist > geom.radius ? geom.radius + distance : Math.max(0.01, geom.radius - distance);
    const newCenter = addPointMut(next.points, c.x, c.y);
    addGeometryMut(next.geometries, { type: 'circle', centerId: newCenter, radius: newR, construction });
    return { ...state, points: next.points, geometries: next.geometries };
  }

  // Arc / ellipse / spline offset not yet supported.
  return null;
}

// ---- Mirror --------------------------------------------------------------

/**
 * Mirror the listed geometries across the line defined by two points.
 * Lines, circles, and arcs are mirrored; other types are skipped.
 * Returns the new state. Each mirrored geometry gets fresh points
 * (the originals are not modified). The new geometries are unselected
 * by convention; the caller can post-process if needed.
 */
export function mirrorSelection(
  state: EditorState,
  geometryIds: ReadonlyArray<SketchGeometryId>,
  axisA: readonly [number, number],
  axisB: readonly [number, number],
): EditorState | null {
  const dx = axisB[0] - axisA[0];
  const dy = axisB[1] - axisA[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return null;
  if (geometryIds.length === 0) return null;

  const reflect = (x: number, y: number): [number, number] => {
    const t = ((x - axisA[0]) * dx + (y - axisA[1]) * dy) / len2;
    const fx = axisA[0] + t * dx;
    const fy = axisA[1] + t * dy;
    return [2 * fx - x, 2 * fy - y];
  };

  const next = makeWorking(state);
  for (const gid of geometryIds) {
    const g = state.geometries.get(gid);
    if (!g) continue;
    if (g.type === 'line') {
      const s = state.points.get(g.startId);
      const e = state.points.get(g.endId);
      if (!s || !e) continue;
      const [sx, sy] = reflect(s.x, s.y);
      const [ex, ey] = reflect(e.x, e.y);
      const ns = addPointMut(next.points, sx, sy);
      const ne = addPointMut(next.points, ex, ey);
      addGeometryMut(next.geometries, { type: 'line', startId: ns, endId: ne, construction: g.construction });
    } else if (g.type === 'circle') {
      const c = state.points.get(g.centerId);
      if (!c) continue;
      const [cx, cy] = reflect(c.x, c.y);
      const nc = addPointMut(next.points, cx, cy);
      addGeometryMut(next.geometries, { type: 'circle', centerId: nc, radius: g.radius, construction: g.construction });
    } else if (g.type === 'arc') {
      const c = state.points.get(g.centerId);
      const s = state.points.get(g.startId);
      const e = state.points.get(g.endId);
      if (!c || !s || !e) continue;
      const [cx, cy] = reflect(c.x, c.y);
      // Mirroring reverses winding: start ↔ end.
      const [sx, sy] = reflect(e.x, e.y);
      const [ex, ey] = reflect(s.x, s.y);
      const nc = addPointMut(next.points, cx, cy);
      const ns = addPointMut(next.points, sx, sy);
      const ne = addPointMut(next.points, ex, ey);
      addGeometryMut(next.geometries, { type: 'arc', centerId: nc, startId: ns, endId: ne, radius: g.radius, construction: g.construction });
    }
    // Ellipse / spline / point mirror not yet supported.
  }
  return { ...state, points: next.points, geometries: next.geometries };
}

// ---- Intersection dispatch (shared by trim) ------------------------------

function intersectLineWith(
  a: SketchPoint, b: SketchPoint,
  other: SketchGeometry,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
): Array<{ x: number; y: number; t: number }> {
  if (other.type === 'line') {
    const c = points.get(other.startId);
    const d = points.get(other.endId);
    if (!c || !d) return [];
    const hit = lineLineIntersect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
    if (!hit) return [];
    if (hit.t2 < -1e-6 || hit.t2 > 1 + 1e-6) return [];
    return [{ x: hit.x, y: hit.y, t: hit.t1 }];
  }
  if (other.type === 'circle') {
    const oc = points.get(other.centerId);
    if (!oc) return [];
    return lineCircleIntersect(a.x, a.y, b.x, b.y, oc.x, oc.y, other.radius);
  }
  if (other.type === 'arc') {
    const oc = points.get(other.centerId);
    const os = points.get(other.startId);
    const oe = points.get(other.endId);
    if (!oc || !os || !oe) return [];
    const r = Math.hypot(os.x - oc.x, os.y - oc.y);
    const all = lineCircleIntersect(a.x, a.y, b.x, b.y, oc.x, oc.y, r);
    return all.filter((h) => pointOnArc(oc, os, oe, h.x, h.y));
  }
  return [];
}

function intersectCircleWith(
  center: SketchPoint, r: number,
  other: SketchGeometry,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
): Array<{ x: number; y: number }> {
  if (other.type === 'line') {
    const a = points.get(other.startId);
    const b = points.get(other.endId);
    if (!a || !b) return [];
    return lineCircleIntersect(a.x, a.y, b.x, b.y, center.x, center.y, r)
      .filter((h) => {
        const t2 = projectOntoLine(h.x, h.y, a, b);
        return t2 !== null && t2 > -1e-6 && t2 < 1 + 1e-6;
      })
      .map((h) => ({ x: h.x, y: h.y }));
  }
  if (other.type === 'circle') {
    const oc = points.get(other.centerId);
    if (!oc) return [];
    return circleCircleIntersect(center.x, center.y, r, oc.x, oc.y, other.radius);
  }
  if (other.type === 'arc') {
    const oc = points.get(other.centerId);
    const os = points.get(other.startId);
    const oe = points.get(other.endId);
    if (!oc || !os || !oe) return [];
    const r2 = Math.hypot(os.x - oc.x, os.y - oc.y);
    return circleCircleIntersect(center.x, center.y, r, oc.x, oc.y, r2)
      .filter((h) => pointOnArc(oc, os, oe, h.x, h.y));
  }
  return [];
}
