/**
 * Constraint dispatcher for the sketch editor.
 *
 * Maps the ribbon constraint buttons (horizontal, vertical, perpendicular,
 * parallel, tangent, equal, coincident, fix) onto the `SketchApplyConstraint`
 * CadCommand based on the current selection.
 *
 * This routes through `dispatchApplyConstraint` (see
 * [sketchDispatch.ts](./sketchDispatch.ts)) so each constraint click
 * becomes one undo entry, and the pre-commit solver pipeline
 * runs identically for ribbon clicks and MCP client dispatches.
 *
 * Validation is conservative: if the selection doesn't fit the constraint
 * (e.g. "perpendicular" needs exactly 2 line segments), the call returns an
 * actionable reason string instead of silently failing. Shell.tsx surfaces
 * that reason in the console.
 *
 * The constraint set is:
 * coincident / horizontal / vertical / parallel / perpendicular / tangent /
 * equal-length-or-radius / fix-point.
 */

import type { SketchEditorState } from './SketchEditorStore.ts';
import type {
  SketchGeometry,
  SketchGeometryId,
  SketchPointId,
} from '@tweakcad/core/src/sketch/types.ts';
import { dispatchApplyConstraint } from './sketchDispatch.ts';

export type ApplyConstraintKind =
  // 'hv' picks horizontal or vertical per-line based on which axis is
  // dominant in the line's current direction (single auto-button).
  | 'hv'
  | 'horizontal'
  | 'vertical'
  | 'perpendicular'
  | 'parallel'
  | 'tangent'
  | 'equal'
  | 'coincident'
  | 'fix'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'symmetric'
  | 'concentric'
  | 'midpoint';

export type ApplyConstraintResult =
  | { ok: true; count: number; conflicted: number }
  | { ok: false; reason: string };

/**
 * Wrap a dispatch and increment the right counter so callers can tell the
 * user "applied 1, rejected 1" instead of blindly logging success when
 * the solver couldn't satisfy the add. Rejection toasts are emitted by
 * `dispatchApplyConstraint` itself — no per-call wiring needed here.
 */
function track(
  build: () => ReturnType<typeof dispatchApplyConstraint>,
  counts: { committed: number; conflicted: number },
): void {
  const result = build();
  if (result.ok) counts.committed++;
  else counts.conflicted++;
}

export function applySketchConstraint(
  store: SketchEditorState,
  kind: ApplyConstraintKind,
): ApplyConstraintResult {
  const lineIds = collectSelectedLines(store);
  const circleIds = collectSelectedCirclesOrArcs(store);
  const pointIds = [...store.selectedPointIds];
  const counts = { committed: 0, conflicted: 0 };

  switch (kind) {
    case 'hv': {
      // Auto: each selected line gets horizontal OR vertical
      // depending on whether its dx or dy is larger. A diagonal line picks
      // the axis it's closer to.
      if (lineIds.length === 0) return { ok: false, reason: 'Select one or more line segments to apply a horizontal/vertical constraint.' };
      for (const id of lineIds) {
        const line = getLine(store, id);
        if (!line) continue;
        const a = store.points.get(line.startId);
        const b = store.points.get(line.endId);
        if (!a || !b) continue;
        const type = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'horizontal' : 'vertical';
        track(() => dispatchApplyConstraint({ type, geometryId: id }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'horizontal': {
      if (lineIds.length === 0) return { ok: false, reason: 'Select one or more line segments to apply a horizontal constraint.' };
      for (const id of lineIds) {
        track(() => dispatchApplyConstraint({ type: 'horizontal', geometryId: id }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'vertical': {
      if (lineIds.length === 0) return { ok: false, reason: 'Select one or more line segments to apply a vertical constraint.' };
      for (const id of lineIds) {
        track(() => dispatchApplyConstraint({ type: 'vertical', geometryId: id }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'parallel': {
      if (lineIds.length < 2) return { ok: false, reason: 'Select two or more line segments to make them parallel.' };
      const first = lineIds[0]!;
      for (let i = 1; i < lineIds.length; i++) {
        track(() => dispatchApplyConstraint({ type: 'parallel', geometryA: first, geometryB: lineIds[i]! }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'perpendicular': {
      if (lineIds.length !== 2) return { ok: false, reason: 'Select exactly two line segments to make them perpendicular.' };
      track(() => dispatchApplyConstraint({ type: 'perpendicular', geometryA: lineIds[0]!, geometryB: lineIds[1]! }), counts);
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'coincident': {
      // Smart dispatch: Coincident is the single button users
      // reach for to "make these touch". Routes based on selection shape:
      //   2+ points              → point-point coincident
      //   1+ points + 1 circle   → pointOnCircle for each (pins to circumference)
      //   1+ points + 1 line     → pointOnLine for each (pins to segment)
      // Falls back to a clear error if the selection doesn't fit any case.
      if (pointIds.length >= 1 && circleIds.length === 1 && lineIds.length === 0) {
        const circleId = circleIds[0]!;
        for (const pid of pointIds) {
          track(() => dispatchApplyConstraint({ type: 'pointOnCircle', pointId: pid, geometryId: circleId }), counts);
        }
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      if (pointIds.length >= 1 && lineIds.length === 1 && circleIds.length === 0) {
        const lineId = lineIds[0]!;
        for (const pid of pointIds) {
          track(() => dispatchApplyConstraint({ type: 'pointOnLine', pointId: pid, geometryId: lineId }), counts);
        }
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      if (pointIds.length >= 2) {
        const anchorId = pointIds[0]!;
        if (!store.points.get(anchorId)) return { ok: false, reason: 'Anchor point not found.' };
        for (let i = 1; i < pointIds.length; i++) {
          const otherId = pointIds[i]!;
          track(() => dispatchApplyConstraint({ type: 'coincident', pointA: anchorId, pointB: otherId }), counts);
        }
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      return { ok: false, reason: 'Select two or more points, or a point + a line/circle, to make them coincident.' };
    }

    case 'fix': {
      if (pointIds.length === 0) return { ok: false, reason: 'Select one or more points to fix in place.' };
      for (const pid of pointIds) {
        const pt = store.points.get(pid);
        if (!pt) continue;
        track(() => dispatchApplyConstraint({ type: 'fixed', pointId: pid, x: pt.x, y: pt.y }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'equal': {
      // Equal is a RELATIONAL constraint — change one entity, the other
      // follows. The solver enforces both ways.
      if (lineIds.length >= 2) {
        const first = lineIds[0]!;
        for (let i = 1; i < lineIds.length; i++) {
          track(() => dispatchApplyConstraint({ type: 'equal', geometryA: first, geometryB: lineIds[i]! }), counts);
        }
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      if (circleIds.length >= 2) {
        const first = circleIds[0]!;
        for (let i = 1; i < circleIds.length; i++) {
          track(() => dispatchApplyConstraint({ type: 'equal', geometryA: first, geometryB: circleIds[i]! }), counts);
        }
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      return { ok: false, reason: 'Select two or more lines or two or more circles/arcs to make them equal.' };
    }

    case 'tangent': {
      // Tangent: line-circle or circle-circle. Solver moves the endpoints
      // to the nearest tangent configuration — no pre-snap, trust the solver.
      if (lineIds.length === 1 && circleIds.length === 1) {
        const lineId = lineIds[0]!;
        const circleId = circleIds[0]!;
        track(() => dispatchApplyConstraint({ type: 'tangent', lineId, circleId }), counts);
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      if (circleIds.length === 2) {
        const a = circleIds[0]!;
        const b = circleIds[1]!;
        // Auto-detect internal vs external from the current geometry.
        // Heuristic: if one circle's center sits inside the other's disk,
        // the user is almost certainly setting up an "internal" tangent
        // (planet-in-ring, bearing-in-bore). Otherwise external.
        // Tangent + Tangent-Internal could be separate ribbon
        // buttons; auto-detect is the lighter UX — explicit override is
        // a follow-up if a workflow ever needs to disagree with the
        // geometry.
        const internal = detectInternalTangent(store, a, b);
        track(
          () => dispatchApplyConstraint({
            type: 'tangent',
            circleId: a,
            secondCircleId: b,
            ...(internal ? { internal: true } : {}),
          }),
          counts,
        );
        return { ok: true, count: counts.committed, conflicted: counts.conflicted };
      }
      return { ok: false, reason: 'Select a line + circle or two circles to make them tangent.' };
    }

    case 'midpoint': {
      // Midpoint: each selected point gets pinned to the midpoint of the
      // selected line segment. Most users pair 1 point + 1 line; we
      // tolerate N points to keep symmetry with pointOnLine. Arc
      // midpoint isn't supported (different math), so reject if the
      // selected geometry isn't a line.
      if (pointIds.length === 0 || lineIds.length === 0) {
        return { ok: false, reason: 'Select one or more points and a line segment.' };
      }
      const lineId = lineIds[0]!;
      for (const pid of pointIds) {
        track(
          () => dispatchApplyConstraint({ type: 'midpoint', pointId: pid, geometryId: lineId }),
          counts,
        );
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'concentric': {
      // Concentric: 2+ circles/arcs share a centre. Each subsequent
      // selection chains to the first (A=B, A=C, …) — same fan-out
      // pattern as Equal: select N circles,
      // click Concentric, all share centres with the first selection.
      if (circleIds.length < 2) {
        return { ok: false, reason: 'Select two or more circles or arcs to make them concentric.' };
      }
      const first = circleIds[0]!;
      for (let i = 1; i < circleIds.length; i++) {
        track(
          () => dispatchApplyConstraint({
            type: 'concentric',
            geometryA: first,
            geometryB: circleIds[i]!,
          }),
          counts,
        );
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'pointOnLine': {
      if (pointIds.length === 0 || lineIds.length === 0) {
        return { ok: false, reason: 'Select one or more points and a line segment.' };
      }
      const lineId = lineIds[0]!;
      for (const pid of pointIds) {
        track(() => dispatchApplyConstraint({ type: 'pointOnLine', pointId: pid, geometryId: lineId }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'pointOnCircle': {
      if (pointIds.length === 0 || circleIds.length === 0) {
        return { ok: false, reason: 'Select one or more points and a circle or arc.' };
      }
      const circleId = circleIds[0]!;
      for (const pid of pointIds) {
        track(() => dispatchApplyConstraint({ type: 'pointOnCircle', pointId: pid, geometryId: circleId }), counts);
      }
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }

    case 'symmetric': {
      if (pointIds.length !== 2 || lineIds.length !== 1) {
        return { ok: false, reason: 'Select exactly two points and one line (the symmetry axis).' };
      }
      track(() => dispatchApplyConstraint({
        type: 'symmetric',
        pointA: pointIds[0]!,
        pointB: pointIds[1]!,
        geometryId: lineIds[0]!,
      }), counts);
      return { ok: true, count: counts.committed, conflicted: counts.conflicted };
    }
  }
}

// ---- Selection helpers ----

function collectSelectedLines(store: SketchEditorState): SketchGeometryId[] {
  const out: SketchGeometryId[] = [];
  for (const id of store.selectedGeometryIds) {
    const g = store.geometries.get(id);
    if (g && g.type === 'line') out.push(id);
  }
  return out;
}

function collectSelectedCirclesOrArcs(store: SketchEditorState): SketchGeometryId[] {
  const out: SketchGeometryId[] = [];
  for (const id of store.selectedGeometryIds) {
    const g = store.geometries.get(id);
    if (g && (g.type === 'circle' || g.type === 'arc')) out.push(id);
  }
  return out;
}

function getLine(store: SketchEditorState, id: SketchGeometryId): Extract<SketchGeometry, { type: 'line' }> | null {
  const g = store.geometries.get(id);
  return g && g.type === 'line' ? g : null;
}

/**
 * Decide internal vs external for a circle-circle tangent click based on
 * current geometry positions. Internal when one circle's center sits
 * inside the other's disk (`d < max(rA, rB)`) — that's the geometric
 * signature of a nested configuration the user just drew. Otherwise
 * external. The user can always overconstrain themselves either way; the
 * auto-detect just picks the likely intent so the ribbon stays a one-
 * click affordance.
 */
function detectInternalTangent(
  store: SketchEditorState,
  aId: SketchGeometryId,
  bId: SketchGeometryId,
): boolean {
  const a = store.geometries.get(aId);
  const b = store.geometries.get(bId);
  if (!a || !b) return false;
  if (a.type !== 'circle' && a.type !== 'arc') return false;
  if (b.type !== 'circle' && b.type !== 'arc') return false;
  const ca = store.points.get(a.centerId);
  const cb = store.points.get(b.centerId);
  if (!ca || !cb) return false;
  const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
  return d < Math.max(a.radius, b.radius);
}

// SketchPointId is intentionally re-exported indirectly via store callers; the
// import keeps the type surface stable if we ever expose helpers below.
export type _ConstraintPointId = SketchPointId;
