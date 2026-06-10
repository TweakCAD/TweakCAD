/**
 * Sketch tool handlers — extended set.
 *
 * The original `sketchTools.ts` owns the dispatcher loop and the four legacy
 * tools (select, line, rectangle, circle). This file owns the rest:
 *   Creation:  arc-3point, arc-center, polygon, slot, ellipse, spline, point
 *   Modify:    trim, extend, sketch-fillet, offset, sketch-mirror
 *
 * Each handler is invoked from the dispatcher with a pre-snapped (x, y) plus
 * the raw sketch position when needed for hit-testing. Handlers mutate the
 * store via `addPoint` / `addGeometry` / `removeGeometry` so the scene
 * manager picks them up through the existing subscribe loop.
 *
 * The session object that drives multi-step tools is owned by sketchTools.ts;
 * we accept and mutate it here as a function argument. This avoids module-
 * level state crossing files.
 */

import type { SketchEditorState } from './SketchEditorStore.ts';
import type { ToolSessionState } from './sketchTools.ts';
import { pickGeometryAt } from '@tweakcad/core/src/sketch/sketchPicking.ts';
import {
  dispatchDrawArc3Point,
  dispatchDrawArcCenter,
  dispatchDrawPolygon,
  dispatchDrawSlot,
  dispatchDrawEllipse,
  dispatchDrawSpline,
  dispatchDrawPoint,
  dispatchTrim,
  dispatchExtend,
  dispatchFillet,
  dispatchOffset,
  dispatchMirror,
} from './sketchDispatch.ts';

// ---- Mutable session bridge ----
//
// Both this file and sketchTools.ts coordinate on a single session object.
// We expose setter/getters that the dispatcher provides via `bindSession()`.

let getSession: () => ToolSessionState = () => null;
let setSession: (next: ToolSessionState) => void = () => {};

/** Called once by sketchTools.ts to share its session object */
export function bindSession(
  getter: () => ToolSessionState,
  setter: (next: ToolSessionState) => void,
): void {
  getSession = getter;
  setSession = setter;
}

// ---- Creation tools ----

export function handleArc3PointClick(
  store: SketchEditorState,
  x: number,
  y: number,
  snapTargetId: string | undefined,
): void {
  const s = getSession();
  if (!s || s.tool !== 'arc-3point') return;
  if (s.phase === 'idle') {
    // Capture snap target for the start click so we can add a coincident
    // constraint when the arc is finalised. exactOptionalPropertyTypes
    // forbids passing `undefined` to an optional, so we spread instead.
    setSession({ tool: 'arc-3point', phase: 'first', x1: x, y1: y, ...(snapTargetId ? { startSnap: snapTargetId } : {}) });
    return;
  }
  if (s.phase === 'first') {
    setSession({
      tool: 'arc-3point', phase: 'second',
      ...(s.x1 !== undefined ? { x1: s.x1 } : {}),
      ...(s.y1 !== undefined ? { y1: s.y1 } : {}),
      x2: x, y2: y,
      ...(s.startSnap ? { startSnap: s.startSnap } : {}),
    });
    return;
  }
  if (s.phase === 'second' && s.x1 !== undefined && s.y1 !== undefined && s.x2 !== undefined && s.y2 !== undefined) {
    // Dispatch as one undo entry. The handler runs `drawArc3Point` which
    // computes the circumscribed-circle center + radius from the three
    // clicks, allocates points via findOrCreatePoint (so snap-targeted
    // coords merge with existing vertices automatically), and writes
    // the arc geometry. The `s.startSnap` / `snapTargetId` info is no
    // longer needed at this layer — coincidence falls out of shared
    // point ids.
    dispatchDrawArc3Point([s.x1, s.y1], [s.x2, s.y2], [x, y], store.constructionMode);
    store.setPreview(null);
    setSession({ tool: 'arc-3point', phase: 'idle' });
  }
}

export function handleArcCenterClick(
  store: SketchEditorState,
  x: number,
  y: number,
  snapTargetId: string | undefined,
): void {
  const s = getSession();
  if (!s || s.tool !== 'arc-center') return;
  if (s.phase === 'idle') {
    setSession({ tool: 'arc-center', phase: 'center', centerX: x, centerY: y, ...(snapTargetId ? { centerSnap: snapTargetId } : {}) });
    return;
  }
  if (s.phase === 'center' && s.centerX !== undefined && s.centerY !== undefined) {
    setSession({
      tool: 'arc-center', phase: 'start',
      centerX: s.centerX, centerY: s.centerY,
      startX: x, startY: y,
      ...(s.centerSnap ? { centerSnap: s.centerSnap } : {}),
      ...(snapTargetId ? { startSnap: snapTargetId } : {}),
    });
    return;
  }
  if (s.phase === 'start'
      && s.centerX !== undefined && s.centerY !== undefined
      && s.startX !== undefined && s.startY !== undefined) {
    const r = Math.hypot(s.startX - s.centerX, s.startY - s.centerY);
    if (r > 0.01) {
      // Convert UI's "click three times" interaction into the core
      // primitive's (center, radius, startAngle, endAngle) shape. The
      // dispatch is one undo entry; snap coincidence falls out of
      // findOrCreatePoint inside `drawArc`.
      const startAngle = Math.atan2(s.startY - s.centerY, s.startX - s.centerX);
      const endAngle = Math.atan2(y - s.centerY, x - s.centerX);
      if (Math.abs(endAngle - startAngle) > 1e-6) {
        dispatchDrawArcCenter([s.centerX, s.centerY], r, startAngle, endAngle, store.constructionMode);
      }
    }
    store.setPreview(null);
    setSession({ tool: 'arc-center', phase: 'idle' });
  }
}

export function handlePolygonClick(
  store: SketchEditorState,
  x: number,
  y: number,
  _snapTargetId: string | undefined,
): void {
  const s = getSession();
  if (!s || s.tool !== 'polygon') return;
  if (s.phase === 'idle') {
    setSession({ tool: 'polygon', phase: 'center', sides: s.sides, centerX: x, centerY: y });
    return;
  }
  if (s.phase === 'center' && s.centerX !== undefined && s.centerY !== undefined) {
    const r = Math.hypot(x - s.centerX, y - s.centerY);
    if (r > 0.01) {
      // Decomposed polygon (Invariant #11) — handler emits N lines +
      // construction center + N coincident + (N-1) equal-length +
      // (N-1) angle. One undo entry. No `SketchPolygon` composite.
      const sides = Math.max(3, Math.min(64, Math.floor(s.sides)));
      dispatchDrawPolygon([s.centerX, s.centerY], [x, y], sides, store.constructionMode);
    }
    store.setPreview(null);
    setSession({ tool: 'polygon', phase: 'idle', sides: s.sides });
  }
}

export function handleSlotClick(
  store: SketchEditorState,
  x: number,
  y: number,
  _snapTargetId: string | undefined,
): void {
  const s = getSession();
  if (!s || s.tool !== 'slot') return;
  if (s.phase === 'idle') {
    setSession({ tool: 'slot', phase: 'first', x1: x, y1: y });
    return;
  }
  if (s.phase === 'first' && s.x1 !== undefined && s.y1 !== undefined) {
    setSession({ tool: 'slot', phase: 'second', x1: s.x1, y1: s.y1, x2: x, y2: y });
    return;
  }
  if (s.phase === 'second' && s.x1 !== undefined && s.y1 !== undefined && s.x2 !== undefined && s.y2 !== undefined) {
    const axisLen = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (axisLen > 0.01) {
      const nx = -(s.y2 - s.y1) / axisLen;
      const ny = (s.x2 - s.x1) / axisLen;
      const width = Math.max(0.5, Math.abs((x - s.x1) * nx + (y - s.y1) * ny) * 2);
      // Decomposed slot (Invariant #11) — handler emits 2 lines + 2
      // arcs + 4 coincident + 4 tangent + 1 equal-radius + 1 parallel.
      // One undo entry. No `SketchSlot` composite.
      dispatchDrawSlot([s.x1, s.y1], [s.x2, s.y2], width, store.constructionMode);
    }
    store.setPreview(null);
    setSession({ tool: 'slot', phase: 'idle' });
  }
}

export function handleEllipseClick(
  store: SketchEditorState,
  x: number,
  y: number,
  _snapTargetId: string | undefined,
): void {
  const s = getSession();
  if (!s || s.tool !== 'ellipse') return;
  if (s.phase === 'idle') {
    setSession({ tool: 'ellipse', phase: 'center', centerX: x, centerY: y });
    return;
  }
  if (s.phase === 'center' && s.centerX !== undefined && s.centerY !== undefined) {
    setSession({ tool: 'ellipse', phase: 'major', centerX: s.centerX, centerY: s.centerY, majorX: x, majorY: y });
    return;
  }
  if (s.phase === 'major'
      && s.centerX !== undefined && s.centerY !== undefined
      && s.majorX !== undefined && s.majorY !== undefined) {
    const dx = s.majorX - s.centerX;
    const dy = s.majorY - s.centerY;
    const majorLen = Math.hypot(dx, dy);
    if (majorLen > 0.01) {
      const nx = -dy / majorLen;
      const ny = dx / majorLen;
      const minor = Math.max(0.5, Math.abs((x - s.centerX) * nx + (y - s.centerY) * ny));
      dispatchDrawEllipse([s.centerX, s.centerY], [s.majorX, s.majorY], minor, store.constructionMode);
    }
    store.setPreview(null);
    setSession({ tool: 'ellipse', phase: 'idle' });
  }
}

export function handleSplineClick(
  _store: SketchEditorState,
  x: number,
  y: number,
): void {
  const s = getSession();
  if (!s || s.tool !== 'spline') return;
  const next: [number, number][] = [...s.points, [x, y]];
  setSession({ tool: 'spline', phase: 'drawing', points: next });

  // No auto-finish cap — the user decides how many points to place and
  // finishes explicitly via Enter or Escape (Escape now finalizes the
  // points drawn so far rather than discarding them).
}

export function finishSpline(store: SketchEditorState): void {
  const s = getSession();
  if (!s || s.tool !== 'spline') return;
  if (s.points.length >= 2) {
    dispatchDrawSpline(s.points.slice(), store.constructionMode);
  }
  store.setPreview(null);
  setSession({ tool: 'spline', phase: 'idle', points: [] });
}

export function handlePointToolClick(
  store: SketchEditorState,
  x: number,
  y: number,
): void {
  dispatchDrawPoint([x, y], store.constructionMode);
}

// ---- Modify tools ----

/**
 * Trim: split the clicked curve at every intersection with another curve,
 * delete only the sub-segment the cursor is in. Falls back to whole-delete
 * for curves with no intersections. The full
 * intersection / bracketing algorithm lives in
 * [@tweakcad/core/src/sketch/modifyOps.ts](@tweakcad/core/src/sketch/modifyOps.ts);
 * the UI session is a thin click-to-dispatch wrapper.
 */
export function handleTrimClick(store: SketchEditorState, x: number, y: number): void {
  const target = pickGeometryAt(store, x, y);
  if (!target) return;
  dispatchTrim(target, [x, y]);
}

/**
 * Extend: lengthen the picked line so it reaches the nearest other line's
 * infinite extension. The cursor pick only identifies WHICH line to extend;
 * the modify primitive in core picks the end and the target.
 */
export function handleExtendClick(store: SketchEditorState, x: number, y: number): void {
  const targetId = pickGeometryAt(store, x, y);
  if (!targetId) return;
  dispatchExtend(targetId);
}

/**
 * Dimension tool — smart dispatch.
 *
 * Pick a line  → length dimension
 * Pick a circle → radius dimension
 * Pick a second line while one is already selected → angle dimension between
 *   the two lines (smart-dimension behaviour, an angle-between
 *   constraint flow).
 *
 * Populates `store.pendingDimension`; the SketchEditor sees this and renders
 * a floating input field. On commit, the editor applies the matching
 * constraint and snaps the geometry.
 *
 * `axisMode` switches the dispatch when the user picks the `dimension-x` or
 * `dimension-y` ribbon variants: picking a line then constrains its endpoints
 * with `distanceX` or `distanceY` instead
 * of Euclidean length.
 */
export function handleDimensionClick(
  store: SketchEditorState,
  x: number,
  y: number,
  axisMode: 'free' | 'x' | 'y' = 'free',
): void {
  const gid = pickGeometryAt(store, x, y);
  if (!gid) {
    store.setPendingDimension(null);
    return;
  }
  const geom = store.geometries.get(gid);
  if (!geom) return;

  // Axis-aligned dimension variants: only meaningful for lines (two real
  // points) or two-centre shapes. For other geometry, fall through to the
  // default smart dispatch below.
  if (axisMode !== 'free' && geom.type === 'line') {
    const a = store.points.get(geom.startId);
    const b = store.points.get(geom.endId);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    store.setPendingDimension({
      kind: axisMode === 'x' ? 'distanceX' : 'distanceY',
      pointA: geom.startId,
      pointB: geom.endId,
      current: axisMode === 'x' ? dx : dy,
      screenX: (a.x + b.x) / 2,
      screenY: (a.y + b.y) / 2,
    });
    return;
  }

  // Smart dimension: if a line is selected and the picked geometry is also a
  // line (and not the same one), pop the angle dimension dialog.
  if (geom.type === 'line') {
    const selectedLineIds = [...store.selectedGeometryIds].filter(id => {
      const g = store.geometries.get(id);
      return g?.type === 'line' && id !== gid;
    });
    if (selectedLineIds.length === 1) {
      const otherId = selectedLineIds[0]!;
      const other = store.geometries.get(otherId);
      if (other?.type === 'line') {
        const a1 = store.points.get(other.startId);
        const a2 = store.points.get(other.endId);
        const b1 = store.points.get(geom.startId);
        const b2 = store.points.get(geom.endId);
        if (a1 && a2 && b1 && b2) {
          const angA = Math.atan2(a2.y - a1.y, a2.x - a1.x);
          const angB = Math.atan2(b2.y - b1.y, b2.x - b1.x);
          // Normalize to (-π, π]
          let diff = angB - angA;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff <= -Math.PI) diff += 2 * Math.PI;
          store.setPendingDimension({
            kind: 'angle',
            geometryA: otherId,
            geometryB: gid,
            current: diff,
            // Dialog appears near the intersection (or midpoint of midpoints).
            screenX: ((a1.x + a2.x) / 2 + (b1.x + b2.x) / 2) / 2,
            screenY: ((a1.y + a2.y) / 2 + (b1.y + b2.y) / 2) / 2,
          });
          return;
        }
      }
    }
  }

  if (geom.type === 'line') {
    const a = store.points.get(geom.startId);
    const b = store.points.get(geom.endId);
    if (!a || !b) return;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    store.setPendingDimension({
      kind: 'length',
      geometryId: gid,
      current: length,
      screenX: (a.x + b.x) / 2,
      screenY: (a.y + b.y) / 2,
    });
    // Select it so the next dimension click can pop angle mode.
    store.selectGeometry(gid, false);
    return;
  }
  if (geom.type === 'circle' || geom.type === 'arc') {
    const c = store.points.get(geom.centerId);
    if (!c) return;
    store.setPendingDimension({
      kind: 'radius',
      geometryId: gid,
      current: geom.radius,
      screenX: c.x + geom.radius * 0.6,
      screenY: c.y + geom.radius * 0.6,
    });
    return;
  }
  // There are no `polygon` or `slot` editor-geometry dimension routes:
  // the tools decompose at draw time, so users dimension a
  // polygon by clicking one of its line segments (length / angle) or a
  // slot by clicking one of its line / arc primitives directly.
  if (geom.type === 'ellipse') {
    // Dimension the major-axis half-length (center → majorId distance).
    const c = store.points.get(geom.centerId);
    const m = store.points.get(geom.majorId);
    if (!c || !m) return;
    const a = Math.hypot(m.x - c.x, m.y - c.y);
    store.setPendingDimension({
      kind: 'distance',
      pointA: geom.centerId,
      pointB: geom.majorId,
      current: a,
      screenX: (c.x + m.x) / 2,
      screenY: (c.y + m.y) / 2,
    });
    return;
  }
}

/**
 * Sketch fillet: round the corner where two lines meet at a shared endpoint.
 * Two-click UI session:
 *   1. Pick first line → stash in session
 *   2. Pick second line → dispatch SketchFillet (handler computes corner +
 *      tangent points + arc; default radius from primitive when undefined).
 */
export function handleSketchFilletClick(store: SketchEditorState, x: number, y: number): void {
  const s = getSession();
  if (!s || s.tool !== 'sketch-fillet') return;
  const pickedId = pickGeometryAt(store, x, y);
  if (!pickedId) return;
  if (s.phase === 'idle') {
    setSession({ tool: 'sketch-fillet', phase: 'first', firstGeomId: pickedId });
    return;
  }
  if (s.phase === 'first' && s.firstGeomId) {
    dispatchFillet(s.firstGeomId, pickedId);
    setSession({ tool: 'sketch-fillet', phase: 'idle' });
  }
}

/**
 * Offset: parallel copy of the clicked line/circle at the session's
 * configured distance. Handler picks the side from the cursor coords.
 */
export function handleOffsetClick(store: SketchEditorState, x: number, y: number): void {
  const s = getSession();
  if (!s || s.tool !== 'offset') return;
  const pickedId = pickGeometryAt(store, x, y);
  if (!pickedId) return;
  dispatchOffset(pickedId, s.distance, [x, y], store.constructionMode);
}

/**
 * Sketch mirror: mirror the current selection across a line defined by two
 * clicks. Click 1 = first axis point; Click 2 = second axis point, dispatches
 * SketchMirror with the editor store's current selectedGeometryIds. The
 * handler does the math + atomic add.
 */
export function handleSketchMirrorClick(store: SketchEditorState, x: number, y: number): void {
  const s = getSession();
  if (!s || s.tool !== 'sketch-mirror') return;
  if (s.phase === 'idle') {
    setSession({ tool: 'sketch-mirror', phase: 'first', firstX: x, firstY: y });
    return;
  }
  if (s.phase === 'first' && s.firstX !== undefined && s.firstY !== undefined) {
    const selected = [...store.selectedGeometryIds];
    if (selected.length > 0) {
      dispatchMirror(selected, [s.firstX, s.firstY], [x, y]);
    }
    setSession({ tool: 'sketch-mirror', phase: 'idle' });
  }
}

// ---- Helpers ----

// The fillet + mirror math lives in
// `@tweakcad/core/src/sketch/modifyOps.ts` (`filletBetweenLines`,
// `mirrorSelection`); the UI handlers above are thin click-to-
// dispatch wrappers. Math primitives (lineLineIntersect, distToSegment,
// circleFrom3Points, projectOntoLine, pointOnArc, lineCircleIntersect,
// circleCircleIntersect) live in `@tweakcad/core/src/sketch/sketchMath.ts`.
// Hit-testing (pickGeometryAt + per-type pickers)
// stays in sketchPicking.ts.
