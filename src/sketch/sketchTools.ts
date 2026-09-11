/**
 * Sketch tool handlers - imperative tool logic for drawing in the sketch editor.
 *
 * Each tool is a set of event handlers (pointerDown, pointerMove, escape)
 * that interact with the SketchEditorStore. Tools commit entities directly
 * to the store, which triggers Three.js scene updates.
 *
 * Tools are imperative handlers - the right fit for these simple tools
 * (line, circle, rectangle, slot, arc): the state is just "idle vs drawing"
 * with one or two click steps, and the store IS the persistent state. A
 * state-machine library (XState, kept in the dependency tree as a future
 * option) is worth adopting per-tool ONLY if a genuinely multi-step tool
 * lands (e.g. assembly joints, multi-rail sweep) where it brings real
 * improvements - not needed for anything shipped today.
 */

import type {
  SketchToolId,
  SketchPointId,
  SketchGeometryId,
} from '@tweakcad/core/src/sketch/types.ts';
import { sketchRegionId } from '@tweakcad/core/src/sketch/types.ts';
import { findRegionForEntity } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { entityId } from '@tweakcad/core/src/ids.ts';
import { useSketchEditorStore, type SketchEditorState } from './SketchEditorStore.ts';
import { circleFrom3Points } from '@tweakcad/core/src/sketch/sketchMath.ts';
import {
  dispatchDrawLine,
  dispatchDrawRectangle,
  dispatchDrawCircle,
  dispatchMovePointsBatch,
  dispatchApplyConstraint,
} from './sketchDispatch.ts';
import {
  bindSession,
  handleArc3PointClick,
  handleArcCenterClick,
  handlePolygonClick,
  handleSlotClick,
  handleEllipseClick,
  handleSplineClick,
  handlePointToolClick,
  handleTrimClick,
  handleExtendClick,
  handleSketchFilletClick,
  handleOffsetClick,
  handleSketchMirrorClick,
  handleDimensionClick,
  finishSpline,
} from './sketchToolsExt.ts';

// ---- Tool State ----

/** Internal state for the active tool's drawing session */
export type ToolSessionState =
  | { tool: 'line'; phase: 'idle' | 'placingEnd' | 'chainPending';
      /** Set during placingEnd: the start point of the current line. */
      startPointId?: SketchPointId; startX?: number; startY?: number;
      /** Set during chainPending: the previous segment's endpoint (used as the start of the next segment, after we insert a fresh chain point + coincident). */
      prevEndPointId?: SketchPointId; prevEndX?: number; prevEndY?: number;
    }
  | { tool: 'rectangle'; phase: 'idle' | 'firstCorner'; x1?: number; y1?: number }
  | { tool: 'circle'; phase: 'idle' | 'center'; centerPointId?: SketchPointId; centerX?: number; centerY?: number }
  // V10 · 2-pt circle: first click captures p1, second commits with
  // centre = midpoint(p1, p2), radius = |p2 - p1| / 2.
  | { tool: 'circle-2point'; phase: 'idle' | 'first'; x1?: number; y1?: number }
  // V10 · 3-pt circle: collect 3 points, solve circumcircle on commit
  // via `circleFrom3Points` (already used by arc-3point).
  | { tool: 'circle-3point'; phase: 'idle' | 'first' | 'second';
      x1?: number; y1?: number; x2?: number; y2?: number }
  | { tool: 'arc-3point'; phase: 'idle' | 'first' | 'second';
      x1?: number; y1?: number; x2?: number; y2?: number;
      /** Snap target captured at the start click — used to add coincident on commit. */
      startSnap?: string;
    }
  | { tool: 'arc-center'; phase: 'idle' | 'center' | 'start';
      centerX?: number; centerY?: number; startX?: number; startY?: number;
      centerSnap?: string; startSnap?: string;
    }
  | { tool: 'polygon'; phase: 'idle' | 'center'; sides: number; centerX?: number; centerY?: number }
  | { tool: 'slot'; phase: 'idle' | 'first' | 'second'; x1?: number; y1?: number; x2?: number; y2?: number }
  | { tool: 'ellipse'; phase: 'idle' | 'center' | 'major'; centerX?: number; centerY?: number; majorX?: number; majorY?: number }
  | { tool: 'spline'; phase: 'idle' | 'drawing'; points: [number, number][] }
  | { tool: 'point'; phase: 'idle' }
  | { tool: 'trim'; phase: 'idle' }
  | { tool: 'extend'; phase: 'idle' }
  | { tool: 'sketch-fillet'; phase: 'idle' | 'first'; firstGeomId?: SketchGeometryId }
  | { tool: 'offset'; phase: 'idle' | 'distance'; distance: number; targetId?: SketchGeometryId }
  | { tool: 'sketch-mirror'; phase: 'idle' | 'first'; firstX?: number; firstY?: number }
  | { tool: 'dimension'; phase: 'idle' }
  | { tool: 'dimension-x'; phase: 'idle' }
  | { tool: 'dimension-y'; phase: 'idle' }
  | {
      tool: 'select';
      phase: 'idle' | 'dragging';
      dragPointId?: SketchPointId;
      dragGeometryId?: SketchGeometryId;
      dragStartX?: number;
      dragStartY?: number;
      lastX?: number;
      lastY?: number;
    }
  | null;

let session: ToolSessionState = null;

// Share the session with sketchToolsExt so its handlers can mutate it too.
bindSession(() => session, (next) => { session = next; });

// ---- Public API ----

/** Reset tool session when switching tools */
export function resetToolSession(tool: SketchToolId): void {
  switch (tool) {
    case 'line':           session = { tool: 'line', phase: 'idle' }; break;
    case 'rectangle':      session = { tool: 'rectangle', phase: 'idle' }; break;
    case 'circle':         session = { tool: 'circle', phase: 'idle' }; break;
    case 'circle-2point':  session = { tool: 'circle-2point', phase: 'idle' }; break;
    case 'circle-3point':  session = { tool: 'circle-3point', phase: 'idle' }; break;
    case 'arc-3point':     session = { tool: 'arc-3point', phase: 'idle' }; break;
    case 'arc-center':     session = { tool: 'arc-center', phase: 'idle' }; break;
    case 'polygon':        session = { tool: 'polygon', phase: 'idle', sides: 6 }; break;
    case 'slot':           session = { tool: 'slot', phase: 'idle' }; break;
    case 'ellipse':        session = { tool: 'ellipse', phase: 'idle' }; break;
    case 'spline':         session = { tool: 'spline', phase: 'idle', points: [] }; break;
    case 'point':          session = { tool: 'point', phase: 'idle' }; break;
    case 'trim':           session = { tool: 'trim', phase: 'idle' }; break;
    case 'extend':         session = { tool: 'extend', phase: 'idle' }; break;
    case 'sketch-fillet':  session = { tool: 'sketch-fillet', phase: 'idle' }; break;
    case 'offset':         session = { tool: 'offset', phase: 'idle', distance: 5 }; break;
    case 'sketch-mirror':  session = { tool: 'sketch-mirror', phase: 'idle' }; break;
    case 'dimension':      session = { tool: 'dimension', phase: 'idle' }; break;
    case 'dimension-x':    session = { tool: 'dimension-x', phase: 'idle' }; break;
    case 'dimension-y':    session = { tool: 'dimension-y', phase: 'idle' }; break;
    case 'select':         session = { tool: 'select', phase: 'idle' }; break;
    default:               session = null;
  }
}

/** Get current tool session state */
export function getToolSession(): ToolSessionState {
  return session;
}

/** Handle pointer down (click) in sketch space */
export function handleToolClick(
  store: SketchEditorState,
  sketchX: number,
  sketchY: number,
  shiftKey: boolean,
): void {
  const snap = store.snapPosition(sketchX, sketchY);
  store.setActiveSnap(snap);
  const x = snap.x;
  const y = snap.y;

  if (!session) return;

  switch (session.tool) {
    case 'line':           handleLineClick(store, x, y, snap.targetId); break;
    case 'rectangle':      handleRectangleClick(store, x, y); break;
    case 'circle':         handleCircleClick(store, x, y, snap.targetId); break;
    case 'circle-2point':  handleCircle2PointClick(store, x, y); break;
    case 'circle-3point':  handleCircle3PointClick(store, x, y); break;
    case 'arc-3point':     handleArc3PointClick(store, x, y, snap.targetId); break;
    case 'arc-center':     handleArcCenterClick(store, x, y, snap.targetId); break;
    case 'polygon':        handlePolygonClick(store, x, y, snap.targetId); break;
    case 'slot':           handleSlotClick(store, x, y, snap.targetId); break;
    case 'ellipse':        handleEllipseClick(store, x, y, snap.targetId); break;
    case 'spline':         handleSplineClick(store, x, y); break;
    case 'point':          handlePointToolClick(store, x, y); break;
    case 'trim':           handleTrimClick(store, sketchX, sketchY); break;
    case 'extend':         handleExtendClick(store, sketchX, sketchY); break;
    case 'sketch-fillet':  handleSketchFilletClick(store, sketchX, sketchY); break;
    case 'offset':         handleOffsetClick(store, sketchX, sketchY); break;
    case 'sketch-mirror':  handleSketchMirrorClick(store, x, y); break;
    case 'dimension':      handleDimensionClick(store, sketchX, sketchY); break;
    case 'dimension-x':    handleDimensionClick(store, sketchX, sketchY, 'x'); break;
    case 'dimension-y':    handleDimensionClick(store, sketchX, sketchY, 'y'); break;
    case 'select':         handleSelectClick(store, x, y, sketchX, sketchY, shiftKey); break;
  }
}

/** Handle pointer move in sketch space */
export function handleToolMove(
  store: SketchEditorState,
  sketchX: number,
  sketchY: number,
): void {
  // During a select-tool drag, exclude the dragged points from snap
  // candidates. Otherwise the dragged point is itself the closest snap
  // target and the cursor snaps back to its current position → the
  // entity appears glued in place (worse when zoomed out, since the
  // snap radius in sketch units scales with 1/zoom).
  const exclude = new Set<SketchPointId>();
  if (session?.tool === 'select' && session.phase === 'dragging') {
    if (session.dragPointId) exclude.add(session.dragPointId);
    if (session.dragGeometryId) {
      for (const pid of store.getGeometryPointIds(session.dragGeometryId)) {
        exclude.add(pid);
      }
    }
  }
  const snap = store.snapPosition(sketchX, sketchY, exclude.size > 0 ? exclude : undefined);
  store.setActiveSnap(snap);
  const x = snap.x;
  const y = snap.y;

  if (!session) return;

  switch (session.tool) {
    case 'line':
      if (session.phase === 'placingEnd' && session.startX !== undefined && session.startY !== undefined) {
        store.setPreview({ type: 'line', startX: session.startX, startY: session.startY, endX: x, endY: y });
        updateLineInferredHint(store, session.startX, session.startY, x, y);
      } else if (session.phase === 'chainPending' && session.prevEndX !== undefined && session.prevEndY !== undefined) {
        // Preview the next segment from the previous junction to the cursor.
        store.setPreview({ type: 'line', startX: session.prevEndX, startY: session.prevEndY, endX: x, endY: y });
        updateLineInferredHint(store, session.prevEndX, session.prevEndY, x, y);
      }
      break;
    case 'rectangle':
      if (session.phase === 'firstCorner' && session.x1 !== undefined && session.y1 !== undefined) {
        store.setPreview({ type: 'rectangle', x1: session.x1, y1: session.y1, x2: x, y2: y });
      }
      break;
    case 'circle':
      if (session.phase === 'center' && session.centerX !== undefined && session.centerY !== undefined) {
        const dx = x - session.centerX;
        const dy = y - session.centerY;
        const radius = Math.sqrt(dx * dx + dy * dy);
        store.setPreview({ type: 'circle', centerX: session.centerX, centerY: session.centerY, radius });
      }
      break;
    case 'circle-2point':
      // After first click, preview the circle whose diameter is
      // (p1, cursor) — centre = midpoint, radius = half the chord.
      if (session.phase === 'first' && session.x1 !== undefined && session.y1 !== undefined) {
        const cxp = (session.x1 + x) * 0.5;
        const cyp = (session.y1 + y) * 0.5;
        const r = Math.hypot(x - session.x1, y - session.y1) * 0.5;
        store.setPreview({ type: 'circle', centerX: cxp, centerY: cyp, radius: r });
      }
      break;
    case 'circle-3point':
      // After 2nd click, preview the circumcircle through the 3 points
      // (cursor is the third). Collinear/degenerate → no preview.
      if (session.phase === 'second'
          && session.x1 !== undefined && session.y1 !== undefined
          && session.x2 !== undefined && session.y2 !== undefined) {
        const cc = circleFrom3Points(session.x1, session.y1, session.x2, session.y2, x, y);
        if (cc) {
          store.setPreview({ type: 'circle', centerX: cc.cx, centerY: cc.cy, radius: cc.r });
        }
      }
      break;
    case 'arc-3point':
      if (session.phase === 'first' && session.x1 !== undefined && session.y1 !== undefined) {
        store.setPreview({ type: 'line', startX: session.x1, startY: session.y1, endX: x, endY: y });
      } else if (session.phase === 'second'
          && session.x1 !== undefined && session.y1 !== undefined
          && session.x2 !== undefined && session.y2 !== undefined) {
        const arc = circleFrom3Points(session.x1, session.y1, session.x2, session.y2, x, y);
        if (arc) {
          const startAngle = Math.atan2(session.y1 - arc.cy, session.x1 - arc.cx);
          const endAngle = Math.atan2(y - arc.cy, x - arc.cx);
          store.setPreview({ type: 'arc', centerX: arc.cx, centerY: arc.cy, radius: arc.r, startAngle, endAngle });
        }
      }
      break;
    case 'arc-center':
      if (session.phase === 'center' && session.centerX !== undefined && session.centerY !== undefined) {
        const dx = x - session.centerX;
        const dy = y - session.centerY;
        store.setPreview({ type: 'circle', centerX: session.centerX, centerY: session.centerY, radius: Math.hypot(dx, dy) });
      } else if (session.phase === 'start'
          && session.centerX !== undefined && session.centerY !== undefined
          && session.startX !== undefined && session.startY !== undefined) {
        const r = Math.hypot(session.startX - session.centerX, session.startY - session.centerY);
        const startAngle = Math.atan2(session.startY - session.centerY, session.startX - session.centerX);
        const endAngle = Math.atan2(y - session.centerY, x - session.centerX);
        store.setPreview({ type: 'arc', centerX: session.centerX, centerY: session.centerY, radius: r, startAngle, endAngle });
      }
      break;
    case 'polygon':
      if (session.phase === 'center' && session.centerX !== undefined && session.centerY !== undefined) {
        store.setPreview({ type: 'polygon', centerX: session.centerX, centerY: session.centerY, vertexX: x, vertexY: y, sides: session.sides });
      }
      break;
    case 'slot':
      if (session.phase === 'first' && session.x1 !== undefined && session.y1 !== undefined) {
        store.setPreview({ type: 'line', startX: session.x1, startY: session.y1, endX: x, endY: y });
      } else if (session.phase === 'second'
          && session.x1 !== undefined && session.y1 !== undefined
          && session.x2 !== undefined && session.y2 !== undefined) {
        // Cursor controls width = perpendicular distance from cursor to axis (* 2)
        const axisLen = Math.hypot(session.x2 - session.x1, session.y2 - session.y1) || 1;
        const nx = -(session.y2 - session.y1) / axisLen;
        const ny = (session.x2 - session.x1) / axisLen;
        const w = Math.max(0.5, Math.abs((x - session.x1) * nx + (y - session.y1) * ny) * 2);
        store.setPreview({ type: 'slot', x1: session.x1, y1: session.y1, x2: session.x2, y2: session.y2, width: w });
      }
      break;
    case 'ellipse':
      if (session.phase === 'center' && session.centerX !== undefined && session.centerY !== undefined) {
        store.setPreview({ type: 'line', startX: session.centerX, startY: session.centerY, endX: x, endY: y });
      } else if (session.phase === 'major'
          && session.centerX !== undefined && session.centerY !== undefined
          && session.majorX !== undefined && session.majorY !== undefined) {
        // Cursor distance perpendicular to major axis = minor radius
        const dx = session.majorX - session.centerX;
        const dy = session.majorY - session.centerY;
        const majorLen = Math.hypot(dx, dy) || 1;
        const nx = -dy / majorLen;
        const ny = dx / majorLen;
        const minor = Math.max(0.5, Math.abs((x - session.centerX) * nx + (y - session.centerY) * ny));
        store.setPreview({ type: 'ellipse', centerX: session.centerX, centerY: session.centerY, majorX: session.majorX, majorY: session.majorY, minorRadius: minor });
      }
      break;
    case 'spline':
      if (session.phase === 'drawing' && session.points.length > 0) {
        store.setPreview({ type: 'spline', points: session.points.slice(), cursorX: x, cursorY: y });
      }
      break;
    case 'select':
      if (session.phase === 'dragging' && session.dragPointId) {
        store.movePoint(session.dragPointId, x, y);
        session.lastX = x;
        session.lastY = y;
      } else if (session.phase === 'dragging' && session.dragGeometryId && session.lastX !== undefined && session.lastY !== undefined) {
        const geom = store.geometries.get(session.dragGeometryId);
        const dx = x - session.lastX;
        const dy = y - session.lastY;
        if (geom) {
          // Batch-move all of the dragged geometry's points in one
          // transaction with the moved set anchored — constraint enforcement
          // adjusts NEIGHBOURING points (e.g. coincident-linked rectangle
          // corners) without overriding the user's drag.
          const updates: { id: import('@tweakcad/core/src/sketch/types.ts').SketchPointId; x: number; y: number }[] = [];
          for (const pointId of store.getGeometryPointIds(geom.id)) {
            const point = store.points.get(pointId);
            if (point) updates.push({ id: pointId, x: point.x + dx, y: point.y + dy });
          }
          if (updates.length > 0) {
            store.movePointsBatch(updates);
          }
        }
        session.lastX = x;
        session.lastY = y;
      }
      break;
  }
}

/** Handle Enter key — commits the spline tool's pending point list. */
export function handleToolEnter(store: SketchEditorState): void {
  if (session?.tool === 'spline') {
    finishSpline(store);
  }
}

/**
 * Handle pointer up.
 *
 * For the select tool's drag flow this is where we commit mid-drag
 * coordinates: dispatch a `SketchMovePoint` per moved point, grouped
 * into a single undo transaction. Mid-drag mutations only updated the
 * editor store (transient UI state); the doc still holds the pre-drag
 * positions until this commit. The hydration subscriber then echoes
 * the new positions back into the store — for any visible position
 * change that round-trip is a no-op since the store already shows
 * them.
 */
export function handleToolPointerUp(
  store: SketchEditorState,
): void {
  if (session?.tool === 'select' && session.phase === 'dragging') {
    // Gather the set of points whose live position in the store now
    // differs from the dispatch destination. For both single-point and
    // geometry-level drag the set is derivable from the session.
    const moves: { pointId: SketchPointId; to: [number, number] }[] = [];
    if (session.dragPointId) {
      const pt = store.points.get(session.dragPointId);
      if (pt) moves.push({ pointId: session.dragPointId, to: [pt.x, pt.y] });
    } else if (session.dragGeometryId) {
      for (const pid of store.getGeometryPointIds(session.dragGeometryId)) {
        const pt = store.points.get(pid);
        if (pt) moves.push({ pointId: pid, to: [pt.x, pt.y] });
      }
    }
    if (moves.length > 0) dispatchMovePointsBatch(moves);
    session = { tool: 'select', phase: 'idle' };
  }
  store.setActiveSnap(null);
}

/**
 * Handle escape key. Returns `true` when the Escape finalized an
 * in-progress operation that should keep the tool active (the caller then
 * does NOT revert to the select tool) — currently only the spline tool's
 * "finish-and-keep" first Escape. All other tools cancel to idle and
 * return `false` so the caller reverts to select.
 */
export function handleToolEscape(store: SketchEditorState): boolean {
  if (!session) return false;
  store.setPreview(null);
  store.setActiveSnap(null);

  // Spline: the first Escape finalizes the points placed so far (keeping
  // them) and stays in the tool; a second Escape (now idle, no pending
  // points) falls through to the switch below and exits like other tools.
  // Matches Fusion's "Esc keeps your points" behavior.
  if (session.tool === 'spline' && session.phase === 'drawing' && session.points.length >= 2) {
    finishSpline(store);
    return true;
  }

  // If mid-drawing, cancel and return to idle phase. After the task-D
  // migration the line / circle tools no longer place orphan points on
  // the first click (the first click just remembers coords), so there's
  // nothing to remove on escape.
  switch (session.tool) {
    case 'line':
      session = { tool: 'line', phase: 'idle' };
      break;
    case 'rectangle':
      session = { tool: 'rectangle', phase: 'idle' };
      break;
    case 'circle':
      session = { tool: 'circle', phase: 'idle' };
      break;
    case 'circle-2point':    session = { tool: 'circle-2point', phase: 'idle' }; break;
    case 'circle-3point':    session = { tool: 'circle-3point', phase: 'idle' }; break;
    case 'arc-3point':       session = { tool: 'arc-3point', phase: 'idle' }; break;
    case 'arc-center':       session = { tool: 'arc-center', phase: 'idle' }; break;
    case 'polygon':          session = { tool: 'polygon', phase: 'idle', sides: session.sides }; break;
    case 'slot':             session = { tool: 'slot', phase: 'idle' }; break;
    case 'ellipse':          session = { tool: 'ellipse', phase: 'idle' }; break;
    case 'spline':           session = { tool: 'spline', phase: 'idle', points: [] }; break;
    case 'point':            session = { tool: 'point', phase: 'idle' }; break;
    case 'trim':             session = { tool: 'trim', phase: 'idle' }; break;
    case 'extend':           session = { tool: 'extend', phase: 'idle' }; break;
    case 'sketch-fillet':    session = { tool: 'sketch-fillet', phase: 'idle' }; break;
    case 'offset':           session = { tool: 'offset', phase: 'idle', distance: session.distance }; break;
    case 'sketch-mirror':    session = { tool: 'sketch-mirror', phase: 'idle' }; break;
    case 'dimension':
      // Cancel any pending dimension prompt and reset
      store.setPendingDimension(null);
      session = { tool: 'dimension', phase: 'idle' };
      break;
    case 'dimension-x':
      store.setPendingDimension(null);
      session = { tool: 'dimension-x', phase: 'idle' };
      break;
    case 'dimension-y':
      store.setPendingDimension(null);
      session = { tool: 'dimension-y', phase: 'idle' };
      break;
    case 'select':
      store.clearSelection();
      session = { tool: 'select', phase: 'idle' };
      break;
  }
  return false;
}

// ---- Line Tool ----

/**
 * Two-click line with chain continuation.
 *
 * Click sequence: 1st captures the start coord, 2nd dispatches
 * `SketchDrawLine` and parks the resulting `endId` + coord as `prevEnd`
 * so the next click chains a fresh segment from there.
 *
 * Chain topology: each segment owns its own distinct endpoints, and
 * the chain is held together by an explicit `coincident` constraint
 * between consecutive `end → next.start` pairs. The `chainFrom` field
 * on `SketchDrawLineCommand` makes this atomic — one dispatch produces
 * the new line AND its chain coincident as a single undo entry. User
 * can tear the chain by removing the coincident in the sketch browser.
 *
 * After each dispatch we read the new segment's `endId` back from the
 * editor store (post-hydration) by diffing the geometry id set before
 * and after — the new id is then the `chainFrom` value for the next
 * click.
 *
 * Snap targets fall out of `findOrCreatePoint` inside `drawLine`: when
 * the cursor snaps to an existing point's exact coords, the end of the
 * segment IS that point. `_snapTargetId` is therefore unused.
 */
/**
 * V8 · Detect whether an in-progress line preview sits within a small
 * angular tolerance of horizontal or vertical, and update the editor
 * store's `inferredHint` accordingly so the overlay can render a chip
 * next to the cursor.
 *
 * Threshold: 5° each side. Wide enough to be more forgiving
 * on a touchpad; if it feels noisy we can tighten it. Below 1 mm
 * segment length we suppress the hint entirely — atan2 on a near-zero
 * vector is meaningless and the chip would flicker.
 */
const HV_HINT_TOLERANCE_RAD = (5 * Math.PI) / 180;
function updateLineInferredHint(
  store: SketchEditorState,
  sx: number, sy: number,
  ex: number, ey: number,
): void {
  const dx = ex - sx, dy = ey - sy;
  const L = Math.hypot(dx, dy);
  if (L < 1) {
    if (store.inferredHint !== null) store.setInferredHint(null);
    return;
  }
  const a = Math.atan2(dy, dx);
  // Distance to horizontal (angle near 0 or ±π).
  const distH = Math.min(Math.abs(a), Math.abs(Math.abs(a) - Math.PI));
  // Distance to vertical (angle near ±π/2).
  const distV = Math.abs(Math.abs(a) - Math.PI / 2);
  if (distH < HV_HINT_TOLERANCE_RAD && distH <= distV) {
    store.setInferredHint({ kind: 'horizontal', sketchX: ex, sketchY: ey });
    return;
  }
  if (distV < HV_HINT_TOLERANCE_RAD) {
    store.setInferredHint({ kind: 'vertical', sketchX: ex, sketchY: ey });
    return;
  }
  if (store.inferredHint !== null) store.setInferredHint(null);
}

function handleLineClick(
  store: SketchEditorState,
  x: number,
  y: number,
  _snapTargetId: string | undefined,
): void {
  if (!session || session.tool !== 'line') return;

  if (session.phase === 'idle') {
    session = {
      tool: 'line',
      phase: 'placingEnd',
      startX: x,
      startY: y,
    };
    return;
  }

  if (session.phase === 'placingEnd') {
    const sx = session.startX;
    const sy = session.startY;
    if (sx !== undefined && sy !== undefined && (sx !== x || sy !== y)) {
      const hint = store.inferredHint;
      const newEndId = dispatchLineAndReadEndId([sx, sy], [x, y], store.constructionMode, undefined);
      // V8 · if a hint glyph was showing at commit, dispatch the
      // matching constraint on the newly-created line. The solver
      // snaps the line flat as part of the same undo step.
      if (newEndId !== undefined && hint) commitInferredHintConstraint(hint.kind, newEndId);
      store.setPreview(null);
      store.setInferredHint(null);
      session = {
        tool: 'line',
        phase: 'chainPending',
        ...(newEndId !== undefined ? { prevEndPointId: newEndId } : {}),
        prevEndX: x,
        prevEndY: y,
      };
      return;
    }
    store.setPreview(null);
    store.setInferredHint(null);
    session = { tool: 'line', phase: 'chainPending', prevEndX: x, prevEndY: y };
    return;
  }

  if (session.phase === 'chainPending') {
    const prevX = session.prevEndX ?? x;
    const prevY = session.prevEndY ?? y;
    if (prevX !== x || prevY !== y) {
      const hint = store.inferredHint;
      const newEndId = dispatchLineAndReadEndId([prevX, prevY], [x, y], store.constructionMode, session.prevEndPointId);
      if (newEndId !== undefined && hint) commitInferredHintConstraint(hint.kind, newEndId);
      store.setPreview(null);
      store.setInferredHint(null);
      session = {
        tool: 'line',
        phase: 'chainPending',
        ...(newEndId !== undefined ? { prevEndPointId: newEndId } : {}),
        prevEndX: x,
        prevEndY: y,
      };
      return;
    }
    store.setPreview(null);
    store.setInferredHint(null);
    session = {
      tool: 'line',
      phase: 'chainPending',
      ...(session.prevEndPointId !== undefined ? { prevEndPointId: session.prevEndPointId } : {}),
      prevEndX: x,
      prevEndY: y,
    };
    return;
  }
}

/**
 * V8 · After dispatching a line, find the geometry id of the just-
 * created line by walking from the endpoint id back to whichever
 * line owns it, then dispatch the matching horizontal/vertical
 * constraint. The store dedup logic will collapse the constraint
 * if one already exists on the same line.
 */
function commitInferredHintConstraint(
  kind: 'horizontal' | 'vertical',
  newEndId: SketchPointId,
): void {
  const store = useSketchEditorStore.getState();
  for (const [gid, g] of store.geometries) {
    if (g.type === 'line' && g.endId === newEndId) {
      dispatchApplyConstraint({ type: kind, geometryId: gid });
      return;
    }
  }
}

/**
 * Dispatch a `SketchDrawLine` and return the new line's `endId` for the
 * chain handle. Diffs geometry ids before/after the dispatch — the
 * single new id is the line we just made; we read its `endId` from the
 * post-hydration editor store.
 */
function dispatchLineAndReadEndId(
  from: [number, number],
  to: [number, number],
  construction: boolean,
  chainFrom: SketchPointId | undefined,
): SketchPointId | undefined {
  const store = useSketchEditorStore.getState();
  const beforeIds = new Set(store.geometries.keys());
  dispatchDrawLine(from, to, construction, chainFrom);
  const after = useSketchEditorStore.getState();
  for (const [gid, geom] of after.geometries) {
    if (beforeIds.has(gid)) continue;
    if (geom.type === 'line') return geom.endId;
  }
  return undefined;
}

// ---- Rectangle Tool ----

function handleRectangleClick(
  store: SketchEditorState,
  x: number,
  y: number,
): void {
  if (!session || session.tool !== 'rectangle') return;

  if (session.phase === 'idle') {
    session = { tool: 'rectangle', phase: 'firstCorner', x1: x, y1: y };
    return;
  }

  if (session.phase === 'firstCorner') {
    // Second click: dispatch the matching CadCommand. The handler runs
    // the same `drawRectangle` core primitive used by the MCP path
    // (8-point + 4 coincident + 2 H + 2 V) — single source of
    // truth + one undo entry per rectangle.
    const x1 = session.x1!;
    const y1 = session.y1!;
    if (Math.abs(x - x1) < 0.01 || Math.abs(y - y1) < 0.01) {
      session = { tool: 'rectangle', phase: 'idle' };
      store.setPreview(null);
      return;
    }
    dispatchDrawRectangle([x1, y1], x - x1, y - y1, store.constructionMode);
    store.setPreview(null);
    session = { tool: 'rectangle', phase: 'idle' };
  }
}

// ---- Circle Tool ----

/**
 * Two-click circle. 1st captures the center coord, 2nd dispatches
 * `SketchDrawCircle(center, radius)` in one undo step.
 *
 * Snap-on-first-click is handled by `findOrCreatePoint` inside
 * `drawCircle`: if a point already exists at the center coords (e.g.
 * snapped to an existing vertex), it's reused; otherwise a fresh one
 * is allocated. `_snapTargetId` is therefore unused — kept for
 * dispatcher symmetry.
 */
function handleCircleClick(
  store: SketchEditorState,
  x: number,
  y: number,
  _snapTargetId: string | undefined,
): void {
  if (!session || session.tool !== 'circle') return;

  if (session.phase === 'idle') {
    // First click: remember coords; no mutation.
    session = {
      tool: 'circle',
      phase: 'center',
      centerX: x,
      centerY: y,
    };
  } else if (session.phase === 'center') {
    const cx = session.centerX!;
    const cy = session.centerY!;
    const radius = Math.hypot(x - cx, y - cy);
    if (radius > 0.01) {
      dispatchDrawCircle([cx, cy], radius, store.constructionMode);
    }
    store.setPreview(null);
    session = { tool: 'circle', phase: 'idle' };
  }
}

/**
 * V10 · Two-point circle. Click 1: capture p1. Click 2: commit a circle
 * whose diameter is segment (p1, p2). Centre = midpoint, radius = half
 * the distance. Same `SketchDrawCircle` command on commit — no new
 * schema entity, no special handling downstream.
 */
function handleCircle2PointClick(
  store: SketchEditorState,
  x: number,
  y: number,
): void {
  if (!session || session.tool !== 'circle-2point') return;
  if (session.phase === 'idle') {
    session = { tool: 'circle-2point', phase: 'first', x1: x, y1: y };
    return;
  }
  if (session.phase === 'first') {
    const x1 = session.x1!;
    const y1 = session.y1!;
    const r = Math.hypot(x - x1, y - y1) * 0.5;
    if (r > 0.01) {
      const cx = (x1 + x) * 0.5;
      const cy = (y1 + y) * 0.5;
      dispatchDrawCircle([cx, cy], r, store.constructionMode);
    }
    store.setPreview(null);
    session = { tool: 'circle-2point', phase: 'idle' };
  }
}

/**
 * V10 · Three-point circle. Three clicks pick points on the circle's
 * boundary; on the third we solve the circumcircle via the existing
 * `circleFrom3Points` helper (used by `arc-3point` for the same math).
 * Three collinear picks return `null` and we silently bail back to
 * idle — same UX as a degenerate arc click.
 */
function handleCircle3PointClick(
  store: SketchEditorState,
  x: number,
  y: number,
): void {
  if (!session || session.tool !== 'circle-3point') return;
  if (session.phase === 'idle') {
    session = { tool: 'circle-3point', phase: 'first', x1: x, y1: y };
    return;
  }
  if (session.phase === 'first') {
    session = {
      tool: 'circle-3point',
      phase: 'second',
      ...(session.x1 !== undefined ? { x1: session.x1 } : {}),
      ...(session.y1 !== undefined ? { y1: session.y1 } : {}),
      x2: x,
      y2: y,
    };
    return;
  }
  if (session.phase === 'second') {
    const cc = circleFrom3Points(session.x1!, session.y1!, session.x2!, session.y2!, x, y);
    if (cc && cc.r > 0.01) {
      dispatchDrawCircle([cc.cx, cc.cy], cc.r, store.constructionMode);
    }
    store.setPreview(null);
    session = { tool: 'circle-3point', phase: 'idle' };
  }
}

// ---- Select Tool ----

function handleSelectClick(
  store: SketchEditorState,
  _x: number,
  _y: number,
  rawX: number,
  rawY: number,
  shiftKey: boolean,
): void {
  if (!session || session.tool !== 'select') return;

  // Hit test is done in SketchEditor component using SketchSceneManager.hitTest
  // The select logic here uses hoveredTarget from the store
  const target = store.hoveredTarget;

  // In selectProfileForFeature mode: clicking geometry auto-selects its region
  if (store.selectionIntent === 'selectProfileForFeature') {
    console.log('[ProfilePick] Click at', rawX.toFixed(1), rawY.toFixed(1), 'target:', target?.type, target?.type === 'region' ? target.id : target?.type === 'geometry' ? String(target.id) : '');
    if (target) {
      if (target.type === 'region') {
        console.log('[ProfilePick] Selecting region directly:', target.id);
        store.selectRegion(target.id, shiftKey);
        session = { tool: 'select', phase: 'idle' };
      } else if (target.type === 'geometry') {
        // Bridge: clicking on a geometry curve selects its region
        const regions = store.getSketchRegions();
        const region = findRegionForEntity(entityId(String(target.id)), regions);
        console.log('[ProfilePick] Geometry bridge:', String(target.id), '->', region?.id ?? 'no match');
        if (region) {
          store.selectRegion(sketchRegionId(region.id), shiftKey);
        }
        session = { tool: 'select', phase: 'idle' };
      } else {
        // Point-in-region test for clicking empty space
        console.log('[ProfilePick] Point click, trying selectRegionAtPoint');
        store.selectRegionAtPoint(rawX, rawY, shiftKey);
        session = { tool: 'select', phase: 'idle' };
      }
    } else {
      // Try point-in-region test (clicking inside a region with no geometry hit)
      console.log('[ProfilePick] No target, trying selectRegionAtPoint');
      store.selectRegionAtPoint(rawX, rawY, shiftKey);
      session = { tool: 'select', phase: 'idle' };
    }
    console.log('[ProfilePick] Selected region IDs after click:', [...store.selectedRegionIds].map(String));
    return;
  }

  // Normal editGeometry mode
  if (target) {
    if (target.type === 'point') {
      // A fixed point is pinned, so never begin a drag on one. Selecting it is
      // still useful (you can inspect it, or hang a constraint off it) — it
      // just doesn't move.
      //
      // Without this the origin followed the cursor for the whole gesture and
      // snapped back on release, because the commit path refuses the move
      // while the live-drag path did not. Letting something appear to move and
      // then undoing it reads as a bug; refusing up front reads as "pinned".
      const targetPoint = store.points.get(target.id);
      if (targetPoint?.fixed) {
        store.selectPoint(target.id, shiftKey);
        session = { tool: 'select', phase: 'idle' };
        return;
      }
      // Start dragging the point
      session = {
        tool: 'select',
        phase: 'dragging',
        dragPointId: target.id,
        dragStartX: rawX,
        dragStartY: rawY,
        lastX: rawX,
        lastY: rawY,
      };
      store.selectPoint(target.id, shiftKey);
    } else if (target.type === 'geometry') {
      store.selectGeometry(target.id, shiftKey);
      session = {
        tool: 'select',
        phase: 'dragging',
        dragGeometryId: target.id,
        dragStartX: rawX,
        dragStartY: rawY,
        lastX: rawX,
        lastY: rawY,
      };
    } else if (target.type === 'region') {
      store.selectRegion(target.id, shiftKey);
      session = { tool: 'select', phase: 'idle' };
    }
  } else {
    // Click on empty space - clear selection
    if (!shiftKey) {
      store.clearSelection();
    }
  }
}
