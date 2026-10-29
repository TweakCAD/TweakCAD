/**
 * Tests for the sketch modify ops — trim, extend, fillet, offset, mirror.
 *
 * Happy paths cover the common UI gesture each tool services:
 *   - trimAt: line crossed by another line, click the segment to remove
 *   - extendAt: line whose extension hits another line, snap to it
 *   - filletBetweenLines: two adjacent corner lines, drop in an arc
 *   - offsetCurveAt: parallel copy of a line on a chosen side
 *   - mirrorSelection: mirror across an axis defined by 2 points
 *
 * Edge cases cover the degenerate inputs the UI is most likely to send
 * (no-intersection trim, unreachable extend, collinear fillet,
 * empty / degenerate mirror axis) and one tracked failure documenting
 * the "fillet on disjoint parallels" validation gap.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyEditorState,
  addConstraint,
  drawLine,
  drawCircle,
  makeCounterIdFactory,
  type EditorState,
} from './operations.ts';
import {
  trimAt,
  extendAt,
  filletBetweenLines,
  offsetCurveAt,
  mirrorSelection,
} from './modifyOps.ts';
import type {
  SketchArc,
  SketchGeometryId,
  SketchLineSegment,
  SketchPoint,
  SketchPointId,
} from './types.ts';

/**
 * Every constraint reference in the state that names a point or geometry
 * the state no longer holds. planegcs resolves each reference by id when
 * it builds the system and throws `sketch object <id> not found` on a
 * miss, so a non-empty result here is a crash on the next solve.
 *
 * Hand-rolled over the field names rather than reusing
 * `constraintReferencesGeometry`: a test that shares the production
 * predicate can't see a reference the predicate itself forgot (which is
 * exactly how `concentric` and `midpoint` went unnoticed).
 */
/** The two endpoints of a line, resolved through the state's point map. */
function lineEnds(state: EditorState, lineId: SketchGeometryId): {
  start: SketchPoint;
  end: SketchPoint;
} {
  const line = state.geometries.get(lineId) as SketchLineSegment;
  return {
    start: state.points.get(line.startId)!,
    end: state.points.get(line.endId)!,
  };
}

/** CCW sweep of an arc, in radians — the span the kernel will build. */
function arcSweep(state: EditorState, arc: SketchArc): number {
  const c = state.points.get(arc.centerId)!;
  const s = state.points.get(arc.startId)!;
  const e = state.points.get(arc.endId)!;
  let sweep = Math.atan2(e.y - c.y, e.x - c.x) - Math.atan2(s.y - c.y, s.x - c.x);
  while (sweep <= 0) sweep += 2 * Math.PI;
  return sweep;
}

function danglingRefs(state: EditorState): string[] {
  const bad: string[] = [];
  const geomKeys = ['geometryId', 'geometryA', 'geometryB', 'lineId', 'circleId', 'secondCircleId'];
  const pointKeys = ['pointId', 'pointA', 'pointB'];
  for (const c of state.constraints.values()) {
    const rec = c as unknown as Record<string, unknown>;
    for (const key of geomKeys) {
      const v = rec[key];
      if (typeof v === 'string' && !state.geometries.has(v as SketchGeometryId)) {
        bad.push(`${c.type}.${key} → missing geometry ${v}`);
      }
    }
    for (const key of pointKeys) {
      const v = rec[key];
      if (typeof v === 'string' && !state.points.has(v as SketchPointId)) {
        bad.push(`${c.type}.${key} → missing point ${v}`);
      }
    }
  }
  return bad;
}

describe('modify ops — happy paths', () => {
  it('trimAt on a line crossed by another line removes the clicked segment', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const horiz = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = horiz.state;
    s = drawLine(s, [5, -5], [5, 5], { idFactory: factory }).state;
    const beforeGeoms = s.geometries.size;
    // Click on the LEFT segment of `horiz` (cursor at x=2).
    const trimmed = trimAt(s, horiz.lineId, [2, 0]);
    expect(trimmed).not.toBeNull();
    // After trim: the horizontal line was split at x=5. The clicked half
    // is removed; the other half remains as a (possibly new) line.
    const lineCount = Array.from(trimmed!.geometries.values()).filter((g) => g.type === 'line').length;
    // 2 pre-trim lines → 1 crossing line + remaining half of horiz = 2.
    expect(lineCount).toBe(2);
    expect(trimmed!.geometries.size).toBeLessThanOrEqual(beforeGeoms);
  });

  it('extendAt on a line whose extension hits another line moves the endpoint', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    // Horizontal line (0,0)→(5,0); vertical wall at x=10.
    const horiz = drawLine(s, [0, 0], [5, 0], { idFactory: factory }); s = horiz.state;
    s = drawLine(s, [10, -5], [10, 5], { idFactory: factory }).state;
    const extended = extendAt(s, horiz.lineId);
    expect(extended).not.toBeNull();
    // The horiz line's end now sits at (10, 0).
    const endPt = extended!.points.get(horiz.endId)!;
    expect(endPt.x).toBeCloseTo(10, 6);
    expect(endPt.y).toBeCloseTo(0, 6);
  });

  it('filletBetweenLines on two perpendicular lines adds an arc + repositions endpoints', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const h = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = h.state;
    const v = drawLine(s, [10, 0], [10, 10], { idFactory: factory }); s = v.state;
    const filleted = filletBetweenLines(s, h.lineId, v.lineId, 2);
    expect(filleted).not.toBeNull();
    const arcs = Array.from(filleted!.geometries.values()).filter((g) => g.type === 'arc');
    expect(arcs).toHaveLength(1);
    expect((arcs[0] as SketchArc).radius).toBeCloseTo(2, 6);
    // The "repositions endpoints" half of the title: the corner retreats
    // by r along each line, and neither line changes direction.
    const hEnd = lineEnds(filleted!, h.lineId).end;
    expect([hEnd.x, hEnd.y]).toEqual([expect.closeTo(8, 6), expect.closeTo(0, 6)]);
    const vStart = lineEnds(filleted!, v.lineId).start;
    expect([vStart.x, vStart.y]).toEqual([expect.closeTo(10, 6), expect.closeTo(2, 6)]);
  });

  it('offsetCurveAt on a horizontal line produces a parallel line at distance', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const line = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = line.state;
    // Cursor below the line → offset goes downward (negative Y).
    const offset = offsetCurveAt(s, line.lineId, 3, [5, -1], false);
    expect(offset).not.toBeNull();
    const lines = Array.from(offset!.geometries.values()).filter((g): g is SketchLineSegment => g.type === 'line');
    expect(lines).toHaveLength(2);
    const newLine = lines.find((l) => l.id !== line.lineId)!;
    const newStart = offset!.points.get(newLine.startId)!;
    const newEnd = offset!.points.get(newLine.endId)!;
    // New line is parallel (same Y), offset by 3 in the cursor direction.
    expect(newStart.y).toBeCloseTo(-3, 6);
    expect(newEnd.y).toBeCloseTo(-3, 6);
  });

  it('mirrorSelection with one line + axis produces a mirrored line', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const line = drawLine(s, [0, 1], [10, 1], { idFactory: factory }); s = line.state;
    // Mirror about the X axis (y = 0).
    const mirrored = mirrorSelection(s, [line.lineId], [0, 0], [1, 0]);
    expect(mirrored).not.toBeNull();
    const lines = Array.from(mirrored!.geometries.values()).filter((g): g is SketchLineSegment => g.type === 'line');
    expect(lines).toHaveLength(2);
    const newLine = lines.find((l) => l.id !== line.lineId)!;
    const ns = mirrored!.points.get(newLine.startId)!;
    const ne = mirrored!.points.get(newLine.endId)!;
    // Original line at y=1; mirror at y=0 → new line at y=-1.
    expect(ns.y).toBeCloseTo(-1, 6);
    expect(ne.y).toBeCloseTo(-1, 6);
  });
});

describe('modify ops — edge cases', () => {
  it('trimAt on a line with no intersections deletes the whole line', () => {
    const factory = makeCounterIdFactory();
    const line = drawLine(emptyEditorState(), [0, 0], [10, 0], { idFactory: factory });
    const trimmed = trimAt(line.state, line.lineId, [5, 0]);
    expect(trimmed).not.toBeNull();
    // No intersections → entire line removed.
    expect(trimmed!.geometries.size).toBe(0);
  });

  it('extendAt with no reachable intersection returns null', () => {
    const factory = makeCounterIdFactory();
    // Lone horizontal line, nothing to hit.
    const line = drawLine(emptyEditorState(), [0, 0], [5, 0], { idFactory: factory });
    const extended = extendAt(line.state, line.lineId);
    expect(extended).toBeNull();
  });

  it('filletBetweenLines on COLLINEAR lines sharing an endpoint returns null', () => {
    // True degenerate corner: two segments along the same line. Caught
    // by the parallel-legs check — collinear is the zero-distance case
    // of the disjoint-parallels test below.
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const a = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = a.state;
    const b = drawLine(s, [10, 0], [20, 0], { idFactory: factory }); s = b.state;
    expect(filletBetweenLines(s, a.lineId, b.lineId, 2)).toBeNull();
  });

  // Two horizontal lines at y=0 and y=5: the closest endpoint pair's
  // midpoint is a pseudo-corner sitting on neither line, and the
  // vectors from it to the far ends form a ~28° angle that the
  // apex-angle check happily accepts. Caught up front instead, on the
  // lines' own directions.
  it('filletBetweenLines on DISJOINT parallel lines returns null', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const a = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = a.state;
    const b = drawLine(s, [0, 5], [10, 5], { idFactory: factory }); s = b.state;
    expect(filletBetweenLines(s, a.lineId, b.lineId, 2)).toBeNull();
  });

  it('mirrorSelection with empty selection returns null', () => {
    expect(mirrorSelection(emptyEditorState(), [], [0, 0], [1, 0])).toBeNull();
  });

  it('mirrorSelection with degenerate axis (two coincident points) returns null', () => {
    const factory = makeCounterIdFactory();
    const line = drawLine(emptyEditorState(), [0, 1], [10, 1], { idFactory: factory });
    expect(mirrorSelection(line.state, [line.lineId], [0, 0], [0, 0])).toBeNull();
  });
});

describe('filletBetweenLines — corner topology', () => {
  /** The ordinary `drawLine` chain: both segments share the corner point. */
  function sharedCorner(): { state: EditorState; hId: SketchGeometryId; vId: SketchGeometryId } {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const h = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = h.state;
    const v = drawLine(s, [10, 0], [10, 10], { idFactory: factory }); s = v.state;
    // Precondition for the bug: `findOrCreatePoint` merged the corner.
    expect(h.endId).toBe(v.startId);
    return { state: s, hId: h.lineId, vId: v.lineId };
  }

  it('keeps both lines on their own axis when they share the corner point', () => {
    const { state, hId, vId } = sharedCorner();
    const filleted = filletBetweenLines(state, hId, vId, 2);
    expect(filleted).not.toBeNull();

    // Each line retreats along itself by r / tan(45°) = 2. A single
    // shared point can't be in two places, so the horizontal line used
    // to get dragged to the vertical line's tangent point (10, 2).
    const hEnd = lineEnds(filleted!, hId).end;
    expect([hEnd.x, hEnd.y]).toEqual([expect.closeTo(8, 6), expect.closeTo(0, 6)]);
    const vStart = lineEnds(filleted!, vId).start;
    expect([vStart.x, vStart.y]).toEqual([expect.closeTo(10, 6), expect.closeTo(2, 6)]);
    // And the lines keep their original far ends.
    expect(lineEnds(filleted!, hId).start).toMatchObject({ x: 0, y: 0 });
    expect(lineEnds(filleted!, vId).end).toMatchObject({ x: 10, y: 10 });
  });

  it('joins the arc to the lines by point id, not by coordinate', () => {
    const { state, hId, vId } = sharedCorner();
    const filleted = filletBetweenLines(state, hId, vId, 2)!;
    const arc = Array.from(filleted.geometries.values()).find((g) => g.type === 'arc') as SketchArc;

    const ends = new Set([lineEnds(filleted, hId).end.id, lineEnds(filleted, vId).start.id]);
    expect(ends.has(arc.startId)).toBe(true);
    expect(ends.has(arc.endId)).toBe(true);
    expect(arc.startId).not.toBe(arc.endId);
  });

  it('sweeps the minor arc whichever line is picked first', () => {
    for (const reversed of [false, true]) {
      const { state, hId, vId } = sharedCorner();
      const [first, second] = reversed ? [vId, hId] : [hId, vId];
      const filleted = filletBetweenLines(state, first, second, 2)!;
      const arc = Array.from(filleted.geometries.values()).find((g) => g.type === 'arc') as SketchArc;
      // Arcs always wind CCW from start to end, so emitting the tangent
      // points in pick order gives the 270° reflex arc half the time.
      expect(arcSweep(filleted, arc)).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('drops the chain coincident that would collapse the corner again', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    // Chain mode (`SketchDrawLine` with `chainFrom`): the second segment
    // owns a distinct start point, tied to the first segment's end by a
    // removable coincident.
    const h = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = h.state;
    const v = drawLine(s, [10, 0], [10, 10], { idFactory: factory, distinctStart: true }); s = v.state;
    expect(v.startId).not.toBe(h.endId);
    const chain = addConstraint(
      s,
      { type: 'coincident', pointA: v.startId, pointB: h.endId },
      { idFactory: factory },
    );
    s = chain.state;

    const filleted = filletBetweenLines(s, h.lineId, v.lineId, 2)!;
    // Left in place, the first solve pulls the two tangent points back
    // together and the corner eats the arc.
    expect(filleted.constraints.has(chain.id)).toBe(false);
    expect(danglingRefs(filleted)).toEqual([]);
  });

  it('keeps unrelated coincidents on the filleted lines', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const h = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = h.state;
    const v = drawLine(s, [10, 0], [10, 10], { idFactory: factory }); s = v.state;
    // A chain joint at the *far* end of the horizontal line.
    const tail = drawLine(s, [0, 0], [0, -5], { idFactory: factory, distinctStart: true }); s = tail.state;
    const keep = addConstraint(
      s,
      { type: 'coincident', pointA: tail.startId, pointB: h.startId },
      { idFactory: factory },
    );
    s = keep.state;

    const filleted = filletBetweenLines(s, h.lineId, v.lineId, 2)!;
    expect(filleted.constraints.has(keep.id)).toBe(true);
    expect(danglingRefs(filleted)).toEqual([]);
  });
});

describe('trimAt — constraint cascade', () => {
  it('drops a geometry constraint on the line it split', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const horiz = drawLine(s, [0, 0], [20, 0], { idFactory: factory }); s = horiz.state;
    s = addConstraint(s, { type: 'horizontal', geometryId: horiz.lineId }, { idFactory: factory }).state;
    s = drawLine(s, [10, -5], [10, 5], { idFactory: factory }).state;

    const trimmed = trimAt(s, horiz.lineId, [15, 0]);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.geometries.has(horiz.lineId)).toBe(false);
    expect(danglingRefs(trimmed!)).toEqual([]);
  });

  it('drops a geometry constraint when the trim is a whole-delete', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const lone = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = lone.state;
    s = addConstraint(s, { type: 'length', geometryId: lone.lineId, value: 10 }, { idFactory: factory }).state;

    // Nothing crosses it, so trim removes the whole line.
    const trimmed = trimAt(s, lone.lineId, [5, 0]);
    expect(trimmed!.geometries.size).toBe(0);
    expect(danglingRefs(trimmed!)).toEqual([]);
  });

  it('drops a radius constraint when a trimmed circle becomes an arc', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const circle = drawCircle(s, { center: [0, 0], radius: 5 }, { idFactory: factory }); s = circle.state;
    s = addConstraint(s, { type: 'radius', geometryId: circle.circleId, value: 5 }, { idFactory: factory }).state;
    s = drawLine(s, [-10, 0], [10, 0], { idFactory: factory }).state;

    const trimmed = trimAt(s, circle.circleId, [0, 5]);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.geometries.has(circle.circleId)).toBe(false);
    expect(danglingRefs(trimmed!)).toEqual([]);
  });

  it('keeps constraints on the geometry it did not touch', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const horiz = drawLine(s, [0, 0], [20, 0], { idFactory: factory }); s = horiz.state;
    const vert = drawLine(s, [10, -5], [10, 5], { idFactory: factory }); s = vert.state;
    const keep = addConstraint(s, { type: 'vertical', geometryId: vert.lineId }, { idFactory: factory });
    s = keep.state;

    const trimmed = trimAt(s, horiz.lineId, [15, 0]);
    expect(trimmed!.constraints.has(keep.id)).toBe(true);
    expect(danglingRefs(trimmed!)).toEqual([]);
  });

  it('drops a point constraint whose point the trim orphaned', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const lone = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = lone.state;
    const other = drawLine(s, [0, 8], [10, 8], { idFactory: factory }); s = other.state;
    s = addConstraint(
      s,
      { type: 'coincident', pointA: lone.startId, pointB: other.startId },
      { idFactory: factory },
    ).state;

    // `lone` has no intersections → whole-delete. Its endpoints are then
    // referenced by nothing but the coincident, which goes with them.
    const trimmed = trimAt(s, lone.lineId, [5, 0]);
    expect(trimmed!.geometries.has(lone.lineId)).toBe(false);
    expect(trimmed!.points.has(lone.startId)).toBe(false);
    expect(danglingRefs(trimmed!)).toEqual([]);
  });
});
