/**
 * Tests for the pure-function sketch operations module.
 *
 * Focus areas:
 *   - Primitives (addPoint, findOrCreatePoint, addGeometry, addConstraint)
 *     preserve immutability and return the right ids.
 *   - Coincident-point merging at the default 1e-6 tolerance works,
 *     and the boundary cases (just inside / just outside) behave.
 *   - Composite drawing tools (drawLine, drawRectangle, drawCircle,
 *     drawArc, drawArc3Point, drawEllipse, drawSpline, drawPoint)
 *     compose the primitives correctly and produce shared corners.
 *   - drawLine flag gaps (distinctStart / distinctEnd / chain model).
 *   - Cross-entity snapping on draw (line / circle / arc reusing
 *     existing reference points).
 *   - addConstraint persistence for every variant in the union.
 *   - movePoint immutability + propagation.
 *   - Snapshot round-trip is lossless (geom + constraints + legacy).
 */

import { describe, it, expect } from 'vitest';
import {
  emptyEditorState,
  addPoint,
  findOrCreatePoint,
  addGeometry,
  addConstraint,
  drawLine,
  drawRectangle,
  drawCircle,
  drawSlot,
  drawPolygon,
  drawArc,
  drawArc3Point,
  drawEllipse,
  drawSpline,
  drawPoint,
  movePoint,
  fromSnapshot,
  toSnapshot,
  makeCounterIdFactory,
  removeGeometry,
  COINCIDENT_TOLERANCE_MM,
  type EditorState,
} from './operations.ts';
import type {
  SketchLineSegment,
  SketchCircle,
  SketchArc,
  SketchEllipse,
  SketchSpline,
  SketchStandalonePoint,
  SketchConstraintInput,
  SketchConstraint,
} from './types.ts';
import { sketchPointId } from './types.ts';

describe('emptyEditorState', () => {
  it('returns empty maps', () => {
    const s = emptyEditorState();
    expect(s.points.size).toBe(0);
    expect(s.geometries.size).toBe(0);
    expect(s.constraints.size).toBe(0);
  });
});

describe('addPoint', () => {
  it('adds a point with the given coords and returns its id', () => {
    const factory = makeCounterIdFactory();
    const { id, state } = addPoint(emptyEditorState(), 10, 20, { idFactory: factory });
    expect(id).toBe('pt_1');
    expect(state.points.size).toBe(1);
    expect(state.points.get(id)).toEqual({ id: 'pt_1', x: 10, y: 20, fixed: false });
  });

  it('does not mutate the input state', () => {
    const factory = makeCounterIdFactory();
    const before = emptyEditorState();
    const { state: after } = addPoint(before, 1, 1, { idFactory: factory });
    expect(before.points.size).toBe(0);
    expect(after.points.size).toBe(1);
    // Maps must be distinct references — same-reference would mean a mutation slipped through.
    expect(after.points).not.toBe(before.points);
  });

  it('respects the fixed flag', () => {
    const factory = makeCounterIdFactory();
    const { state } = addPoint(emptyEditorState(), 0, 0, { idFactory: factory, fixed: true });
    const pt = Array.from(state.points.values())[0]!;
    expect(pt.fixed).toBe(true);
  });
});

describe('findOrCreatePoint', () => {
  it('creates a new point when none is within tolerance', () => {
    const factory = makeCounterIdFactory();
    const { id, reused, state } = findOrCreatePoint(emptyEditorState(), 5, 5, { idFactory: factory });
    expect(reused).toBe(false);
    expect(id).toBe('pt_1');
    expect(state.points.size).toBe(1);
  });

  it('reuses an existing point id when coords match exactly', () => {
    const factory = makeCounterIdFactory();
    const first = findOrCreatePoint(emptyEditorState(), 5, 5, { idFactory: factory });
    const second = findOrCreatePoint(first.state, 5, 5, { idFactory: factory });
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.state.points.size).toBe(1);
  });

  it('reuses when coords are within the default 1e-6 tolerance', () => {
    const factory = makeCounterIdFactory();
    const first = findOrCreatePoint(emptyEditorState(), 10, 20, { idFactory: factory });
    const second = findOrCreatePoint(first.state, 10 + COINCIDENT_TOLERANCE_MM / 2, 20, { idFactory: factory });
    expect(second.id).toBe(first.id);
    expect(second.reused).toBe(true);
  });

  it('allocates a fresh point when coords differ by more than tolerance', () => {
    const factory = makeCounterIdFactory();
    const first = findOrCreatePoint(emptyEditorState(), 10, 20, { idFactory: factory });
    const second = findOrCreatePoint(first.state, 10 + 1e-3, 20, { idFactory: factory });
    expect(second.id).not.toBe(first.id);
    expect(second.reused).toBe(false);
    expect(second.state.points.size).toBe(2);
  });

  it('honors a custom larger tolerance', () => {
    const factory = makeCounterIdFactory();
    const first = findOrCreatePoint(emptyEditorState(), 0, 0, { idFactory: factory });
    const second = findOrCreatePoint(first.state, 0.5, 0, { idFactory: factory, tolerance: 1 });
    expect(second.id).toBe(first.id);
    expect(second.reused).toBe(true);
  });
});

describe('addGeometry', () => {
  it('appends with auto-generated id when no override given', () => {
    const factory = makeCounterIdFactory();
    const p = addPoint(emptyEditorState(), 0, 0, { idFactory: factory });
    const q = addPoint(p.state, 1, 0, { idFactory: factory });
    const { id, state } = addGeometry(
      q.state,
      { type: 'line', startId: p.id, endId: q.id, construction: false },
      { idFactory: factory },
    );
    expect(id).toBe('geo_1');
    expect(state.geometries.size).toBe(1);
  });

  it('honors an idOverride for deterministic naming (rectangle edges)', () => {
    const factory = makeCounterIdFactory();
    const p = addPoint(emptyEditorState(), 0, 0, { idFactory: factory });
    const q = addPoint(p.state, 1, 0, { idFactory: factory });
    const { id, state } = addGeometry(
      q.state,
      { type: 'line', startId: p.id, endId: q.id, construction: false },
      { idFactory: factory, idOverride: 'custom_edge_id' as never },
    );
    expect(id).toBe('custom_edge_id' as never);
    expect(state.geometries.get(id)).toBeDefined();
  });
});

describe('drawLine', () => {
  it('allocates two points and a line geometry for a fresh sketch', () => {
    const factory = makeCounterIdFactory();
    const result = drawLine(emptyEditorState(), [0, 0], [10, 0], { idFactory: factory });
    expect(result.state.points.size).toBe(2);
    expect(result.state.geometries.size).toBe(1);
    const line = result.state.geometries.get(result.lineId) as SketchLineSegment;
    expect(line.type).toBe('line');
    expect(line.startId).toBe(result.startId);
    expect(line.endId).toBe(result.endId);
  });

  it('reuses endpoints from a prior line to form a closed loop', () => {
    // This is the core mechanism that produces extrudable rectangles:
    // 4 sequential drawLine calls with matching corner coords share
    // the point ids at each corner, so the loop detector sees a closed
    // path instead of 4 strangers.
    const factory = makeCounterIdFactory();
    const l1 = drawLine(emptyEditorState(), [0, 0], [10, 0], { idFactory: factory });
    const l2 = drawLine(l1.state, [10, 0], [10, 10], { idFactory: factory });
    const l3 = drawLine(l2.state, [10, 10], [0, 10], { idFactory: factory });
    const l4 = drawLine(l3.state, [0, 10], [0, 0], { idFactory: factory });

    // Exactly 4 points + 4 lines — no duplicates.
    expect(l4.state.points.size).toBe(4);
    expect(l4.state.geometries.size).toBe(4);
    // Sequential lines share endpoints (l1.endId === l2.startId, etc.).
    expect(l1.endId).toBe(l2.startId);
    expect(l2.endId).toBe(l3.startId);
    expect(l3.endId).toBe(l4.startId);
    // And the loop closes (l4.endId === l1.startId).
    expect(l4.endId).toBe(l1.startId);
  });

  it('respects the construction flag', () => {
    const factory = makeCounterIdFactory();
    const result = drawLine(emptyEditorState(), [0, 0], [1, 0], { idFactory: factory, construction: true });
    const line = result.state.geometries.get(result.lineId) as SketchLineSegment;
    expect(line.construction).toBe(true);
  });
});

describe('drawRectangle (8-point model)', () => {
  it('allocates 8 distinct corner points + 4 edge geometries + 8 constraints', () => {
    const factory = makeCounterIdFactory();
    const result = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 60, height: 30 }, {
      idFactory: factory,
    });
    // 8-point model: each of the 4 edges owns 2 distinct endpoints.
    expect(result.state.points.size).toBe(8);
    expect(result.state.geometries.size).toBe(4);
    // 4 corner coincidents + 2 horizontal + 2 vertical.
    expect(result.state.constraints.size).toBe(8);

    // All 4 edges are lines.
    for (const edgeId of [result.edges.bottom, result.edges.right, result.edges.top, result.edges.left]) {
      const geom = result.state.geometries.get(edgeId);
      expect(geom?.type).toBe('line');
    }
  });

  it('emits the 4 corner coincidents linking adjacent endpoints', () => {
    const factory = makeCounterIdFactory();
    const result = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 10, height: 10 }, {
      idFactory: factory,
    });
    // Adjacent endpoints DO NOT share ids — they share coordinates and are
    // linked by coincident constraints.
    expect(result.points.bottomEnd).not.toBe(result.points.rightStart);
    expect(result.points.rightEnd).not.toBe(result.points.topStart);
    expect(result.points.topEnd).not.toBe(result.points.leftStart);
    expect(result.points.leftEnd).not.toBe(result.points.bottomStart);

    // 4 coincidents reference the right point pairs.
    const coincidents = Array.from(result.state.constraints.values())
      .filter((c) => c.type === 'coincident');
    expect(coincidents).toHaveLength(4);
    const pairs = coincidents.map((c) => {
      if (c.type !== 'coincident') return '';
      // Sort the pair so we can compare regardless of order.
      return [c.pointA, c.pointB].sort().join('|');
    }).sort();
    const expected = [
      [result.points.bottomEnd, result.points.rightStart].sort().join('|'),
      [result.points.rightEnd, result.points.topStart].sort().join('|'),
      [result.points.topEnd, result.points.leftStart].sort().join('|'),
      [result.points.leftEnd, result.points.bottomStart].sort().join('|'),
    ].sort();
    expect(pairs).toEqual(expected);
  });

  it('locks bottom + top horizontal and right + left vertical', () => {
    const factory = makeCounterIdFactory();
    const result = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 10, height: 10 }, {
      idFactory: factory,
    });
    const horizontals = Array.from(result.state.constraints.values())
      .filter((c) => c.type === 'horizontal');
    const verticals = Array.from(result.state.constraints.values())
      .filter((c) => c.type === 'vertical');
    expect(horizontals).toHaveLength(2);
    expect(verticals).toHaveLength(2);
    const hGeometryIds = new Set(horizontals.map((c) => c.type === 'horizontal' ? c.geometryId : ''));
    const vGeometryIds = new Set(verticals.map((c) => c.type === 'vertical' ? c.geometryId : ''));
    expect(hGeometryIds.has(result.edges.bottom)).toBe(true);
    expect(hGeometryIds.has(result.edges.top)).toBe(true);
    expect(vGeometryIds.has(result.edges.right)).toBe(true);
    expect(vGeometryIds.has(result.edges.left)).toBe(true);
  });

  it('does NOT merge corner points with pre-existing coincident points', () => {
    // Under the 8-point model the rectangle owns its corners. External
    // coincidence is expressed as a constraint, not as a shared id —
    // so a pre-existing point at a corner location is left alone.
    const factory = makeCounterIdFactory();
    const pre = addPoint(emptyEditorState(), 5, 5, { idFactory: factory });
    const result = drawRectangle(pre.state, { corner: [5, 5], width: 10, height: 10 }, {
      idFactory: factory,
    });
    // 1 pre-existing point + 8 rectangle corners = 9 total.
    expect(result.state.points.size).toBe(9);
    expect(result.points.bottomStart).not.toBe(pre.id);
  });

  it('normalizes negative width/height', () => {
    const factory = makeCounterIdFactory();
    const result = drawRectangle(emptyEditorState(), { corner: [10, 10], width: -5, height: -5 }, {
      idFactory: factory,
    });
    // Every coord is in {5, 10} regardless of sign of width/height.
    for (const p of result.state.points.values()) {
      expect([5, 10]).toContain(p.x);
      expect([5, 10]).toContain(p.y);
    }
  });
});

describe('drawCircle', () => {
  it('allocates a center point and a circle geometry', () => {
    const factory = makeCounterIdFactory();
    const result = drawCircle(emptyEditorState(), { center: [0, 0], radius: 5 }, { idFactory: factory });
    expect(result.state.points.size).toBe(1);
    expect(result.state.geometries.size).toBe(1);
    const circle = result.state.geometries.get(result.circleId) as SketchCircle;
    expect(circle.type).toBe('circle');
    expect(circle.radius).toBe(5);
    expect(circle.centerId).toBe(result.centerId);
  });

  it('reuses an existing center point when coords match', () => {
    const factory = makeCounterIdFactory();
    const pre = addPoint(emptyEditorState(), 10, 10, { idFactory: factory });
    const result = drawCircle(pre.state, { center: [10, 10], radius: 3 }, { idFactory: factory });
    expect(result.state.points.size).toBe(1);
    expect(result.centerId).toBe(pre.id);
  });

  it('rejects non-positive radius', () => {
    expect(() => drawCircle(emptyEditorState(), { center: [0, 0], radius: 0 })).toThrow();
    expect(() => drawCircle(emptyEditorState(), { center: [0, 0], radius: -1 })).toThrow();
  });
});

describe('drawSlot (decomposed: 2 lines + 2 arcs + constraints)', () => {
  it('emits 10 points + 4 geometries + 10 constraints — no composite slot entity', () => {
    const factory = makeCounterIdFactory();
    const result = drawSlot(
      emptyEditorState(),
      { center1: [0, 0], center2: [20, 0], width: 6 },
      { idFactory: factory },
    );
    // 2 centers + 8 distinct corner points.
    expect(result.state.points.size).toBe(10);
    // 2 lines + 2 arcs.
    expect(result.state.geometries.size).toBe(4);
    const geomTypes = Array.from(result.state.geometries.values()).map((g) => g.type).sort();
    expect(geomTypes).toEqual(['arc', 'arc', 'line', 'line']);
    // 4 coincident + 4 tangent + 1 equal + 1 parallel.
    expect(result.state.constraints.size).toBe(10);
  });

  it('the 4 corners use 8 distinct point ids (coincidence is a constraint)', () => {
    const factory = makeCounterIdFactory();
    const result = drawSlot(
      emptyEditorState(),
      { center1: [0, 0], center2: [20, 0], width: 6 },
      { idFactory: factory },
    );
    // Line and arc at the same corner own DIFFERENT point ids.
    expect(result.corners.topLeftLine).not.toBe(result.corners.topLeftArc);
    expect(result.corners.bottomLeftLine).not.toBe(result.corners.bottomLeftArc);
    expect(result.corners.topRightLine).not.toBe(result.corners.topRightArc);
    expect(result.corners.bottomRightLine).not.toBe(result.corners.bottomRightArc);
    // All 8 corner point ids are unique.
    const ids = new Set([
      result.corners.topLeftLine, result.corners.topLeftArc,
      result.corners.bottomLeftLine, result.corners.bottomLeftArc,
      result.corners.topRightLine, result.corners.topRightArc,
      result.corners.bottomRightLine, result.corners.bottomRightArc,
    ]);
    expect(ids.size).toBe(8);
  });

  it('arc radii equal half the width and centers are placed at the requested coords', () => {
    const factory = makeCounterIdFactory();
    const result = drawSlot(
      emptyEditorState(),
      { center1: [0, 0], center2: [20, 0], width: 8 },
      { idFactory: factory },
    );
    const arcLeft = result.state.geometries.get(result.arcs.left) as SketchArc;
    const arcRight = result.state.geometries.get(result.arcs.right) as SketchArc;
    expect(arcLeft.type).toBe('arc');
    expect(arcRight.type).toBe('arc');
    expect(arcLeft.radius).toBe(4);
    expect(arcRight.radius).toBe(4);
    expect(arcLeft.centerId).toBe(result.center1Id);
    expect(arcRight.centerId).toBe(result.center2Id);
    const c1 = result.state.points.get(result.center1Id)!;
    const c2 = result.state.points.get(result.center2Id)!;
    expect(c1.x).toBe(0);
    expect(c1.y).toBe(0);
    expect(c2.x).toBe(20);
    expect(c2.y).toBe(0);
  });

  it('rejects coincident centers and non-positive width', () => {
    expect(() => drawSlot(emptyEditorState(), { center1: [0, 0], center2: [0, 0], width: 4 })).toThrow();
    expect(() => drawSlot(emptyEditorState(), { center1: [0, 0], center2: [10, 0], width: 0 })).toThrow();
    expect(() => drawSlot(emptyEditorState(), { center1: [0, 0], center2: [10, 0], width: -1 })).toThrow();
  });

  it('emits the right constraint mix (4 coincident, 4 tangent, 1 equal, 1 parallel)', () => {
    const factory = makeCounterIdFactory();
    const result = drawSlot(
      emptyEditorState(),
      { center1: [0, 0], center2: [20, 0], width: 6 },
      { idFactory: factory },
    );
    const counts: Record<string, number> = {};
    for (const c of result.state.constraints.values()) {
      counts[c.type] = (counts[c.type] ?? 0) + 1;
    }
    expect(counts['coincident']).toBe(4);
    expect(counts['tangent']).toBe(4);
    expect(counts['equal']).toBe(1);
    expect(counts['parallel']).toBe(1);
  });
});

describe('drawPolygon (decomposed: N lines + center + constraints)', () => {
  it('hexagon: 13 points (1 center + 12 endpoints) + 7 geoms (6 lines + 1 point) + 16 constraints', () => {
    const factory = makeCounterIdFactory();
    const result = drawPolygon(
      emptyEditorState(),
      { center: [0, 0], vertex: [10, 0], sides: 6 },
      { idFactory: factory },
    );
    expect(result.state.points.size).toBe(13);
    expect(result.state.geometries.size).toBe(7);
    // 6 coincident + 5 equal + 5 angle.
    expect(result.state.constraints.size).toBe(16);
    expect(result.lineIds).toHaveLength(6);
    expect(result.vertexStartIds).toHaveLength(6);
    expect(result.vertexEndIds).toHaveLength(6);
    // The construction center is a 'point' geometry, marked construction.
    const centerGeom = result.state.geometries.get(result.centerGeometryId) as SketchStandalonePoint;
    expect(centerGeom.type).toBe('point');
    expect(centerGeom.construction).toBe(true);
    expect(centerGeom.pointId).toBe(result.centerId);
  });

  it('triangle (sides=3): 7 points + 4 geoms + 6 constraints (3 coincident + 2 equal + 2 angle)', () => {
    const factory = makeCounterIdFactory();
    const result = drawPolygon(
      emptyEditorState(),
      { center: [0, 0], vertex: [5, 0], sides: 3 },
      { idFactory: factory },
    );
    expect(result.state.points.size).toBe(7);
    expect(result.state.geometries.size).toBe(4); // 3 lines + 1 construction point
    expect(result.state.constraints.size).toBe(7); // 3 coincident + 2 equal + 2 angle
    const counts: Record<string, number> = {};
    for (const c of result.state.constraints.values()) {
      counts[c.type] = (counts[c.type] ?? 0) + 1;
    }
    expect(counts['coincident']).toBe(3);
    expect(counts['equal']).toBe(2);
    expect(counts['angle']).toBe(2);
  });

  it('angle constraint value is the exterior turn angle 2π/N', () => {
    const factory = makeCounterIdFactory();
    const result = drawPolygon(
      emptyEditorState(),
      { center: [0, 0], vertex: [5, 0], sides: 6 },
      { idFactory: factory },
    );
    const angles = Array.from(result.state.constraints.values()).filter((c) => c.type === 'angle');
    expect(angles.length).toBe(5);
    for (const a of angles) {
      if (a.type !== 'angle') continue;
      expect(a.value).toBeCloseTo((2 * Math.PI) / 6, 12);
    }
  });

  it('vertex coords lie on the circumscribed circle through the requested vertex', () => {
    const factory = makeCounterIdFactory();
    const r = 10;
    const result = drawPolygon(
      emptyEditorState(),
      { center: [0, 0], vertex: [r, 0], sides: 5 },
      { idFactory: factory },
    );
    // Every line endpoint should sit at distance r from center.
    for (const id of [...result.vertexStartIds, ...result.vertexEndIds]) {
      const p = result.state.points.get(id)!;
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(r, 9);
    }
  });

  it('rejects sides outside [3, 64], non-integer sides, and coincident center/vertex', () => {
    expect(() => drawPolygon(emptyEditorState(), { center: [0, 0], vertex: [5, 0], sides: 2 })).toThrow();
    expect(() => drawPolygon(emptyEditorState(), { center: [0, 0], vertex: [5, 0], sides: 65 })).toThrow();
    expect(() => drawPolygon(emptyEditorState(), { center: [0, 0], vertex: [5, 0], sides: 4.5 })).toThrow();
    expect(() => drawPolygon(emptyEditorState(), { center: [0, 0], vertex: [0, 0], sides: 4 })).toThrow();
  });
});

describe('snapshot round-trip', () => {
  it('fromSnapshot(toSnapshot(state)) preserves all entities', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    s = drawRectangle(s, { corner: [0, 0], width: 10, height: 5 }, { idFactory: factory }).state;
    s = drawCircle(s, { center: [5, 5], radius: 1 }, { idFactory: factory }).state;
    const snap = toSnapshot(s);
    const restored = fromSnapshot(snap);
    expect(restored.points.size).toBe(s.points.size);
    expect(restored.geometries.size).toBe(s.geometries.size);
    for (const [id, p] of s.points) {
      expect(restored.points.get(id)).toEqual(p);
    }
    for (const [id, g] of s.geometries) {
      expect(restored.geometries.get(id)).toEqual(g);
    }
  });

  it('fromSnapshot(undefined) returns an empty state', () => {
    const s = fromSnapshot(undefined);
    expect(s.points.size).toBe(0);
    expect(s.geometries.size).toBe(0);
    expect(s.constraints.size).toBe(0);
  });

  it('toSnapshot returns plain arrays serializable to JSON', () => {
    const factory = makeCounterIdFactory();
    const s = drawLine(emptyEditorState(), [0, 0], [1, 1], { idFactory: factory }).state;
    const snap = toSnapshot(s);
    expect(Array.isArray(snap.points)).toBe(true);
    expect(Array.isArray(snap.geometries)).toBe(true);
    // Round-trip through JSON to confirm no Map / unserializable values leaked in.
    const roundtripped = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(roundtripped.points.length).toBe(2);
    expect(roundtripped.geometries.length).toBe(1);
  });

  // F1 — round-trip preserves constraints attached to mixed geometry.
  it('round-trip preserves all constraints from a rectangle + circle + manual tangent', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    s = drawRectangle(s, { corner: [0, 0], width: 10, height: 5 }, { idFactory: factory }).state;
    const c = drawCircle(s, { center: [20, 0], radius: 3 }, { idFactory: factory });
    s = c.state;
    // Manual tangent between the circle and one of the rectangle's lines.
    const someLine = Array.from(s.geometries.values()).find((g) => g.type === 'line')!;
    s = addConstraint(s, {
      type: 'tangent',
      lineId: someLine.id,
      circleId: c.circleId,
    }, { idFactory: factory }).state;
    const snap = toSnapshot(s);
    const restored = fromSnapshot(snap);
    expect(restored.constraints.size).toBe(s.constraints.size);
    for (const id of s.constraints.keys()) {
      expect(restored.constraints.has(id)).toBe(true);
    }
  });

  // F2 — old `.cadjson` files may still carry `{type:'slot'}` / `{type:'polygon'}`
  // entries from the pre-bigbang composite-shape era. fromSnapshot must
  // accept them silently; see types.ts L62-67.
  it('fromSnapshot accepts legacy slot/polygon geometry entries silently', () => {
    const snap = {
      points: [],
      geometries: [
        { id: 'legacy_slot', type: 'slot', construction: false } as unknown,
        { id: 'legacy_poly', type: 'polygon', construction: false } as unknown,
      ],
      constraints: [],
    };
    expect(() => fromSnapshot(snap as never)).not.toThrow();
    const restored = fromSnapshot(snap as never);
    expect(restored.geometries.size).toBe(2);
  });
});

// =============================================================================
// drawArc / drawArc3Point / drawEllipse / drawSpline / drawPoint
// =============================================================================

describe('drawArc', () => {
  it('center + start/end angles produces 3 points + 1 arc, radius preserved', () => {
    const factory = makeCounterIdFactory();
    const result = drawArc(
      emptyEditorState(),
      { center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI / 2 },
      { idFactory: factory },
    );
    expect(result.state.points.size).toBe(3);
    expect(result.state.geometries.size).toBe(1);
    const arc = result.state.geometries.get(result.arcId) as SketchArc;
    expect(arc.type).toBe('arc');
    expect(arc.radius).toBe(5);
    expect(arc.centerId).toBe(result.centerId);
    expect(arc.startId).toBe(result.startId);
    expect(arc.endId).toBe(result.endId);
    const startPt = result.state.points.get(result.startId)!;
    expect(startPt.x).toBeCloseTo(5, 9);
    expect(startPt.y).toBeCloseTo(0, 9);
  });

  it('rejects zero or negative radius', () => {
    expect(() => drawArc(emptyEditorState(),
      { center: [0, 0], radius: 0, startAngle: 0, endAngle: 1 })).toThrow();
    expect(() => drawArc(emptyEditorState(),
      { center: [0, 0], radius: -1, startAngle: 0, endAngle: 1 })).toThrow();
  });

  it('rejects equal start/end angles (zero-length arc)', () => {
    expect(() => drawArc(emptyEditorState(),
      { center: [0, 0], radius: 5, startAngle: 1, endAngle: 1 })).toThrow();
  });
});

describe('drawArc3Point', () => {
  it('well-conditioned 3 points → arc lands on the derived circumcircle', () => {
    const factory = makeCounterIdFactory();
    // Three points on circle radius 5 at origin.
    const result = drawArc3Point(
      emptyEditorState(),
      { start: [5, 0], mid: [0, 5], end: [-5, 0] },
      { idFactory: factory },
    );
    const arc = result.state.geometries.get(result.arcId) as SketchArc;
    expect(arc.type).toBe('arc');
    expect(arc.radius).toBeCloseTo(5, 6);
    const centerPt = result.state.points.get(result.centerId)!;
    expect(centerPt.x).toBeCloseTo(0, 6);
    expect(centerPt.y).toBeCloseTo(0, 6);
  });

  it('rejects 3 collinear points (infinite radius)', () => {
    expect(() => drawArc3Point(emptyEditorState(),
      { start: [0, 0], mid: [5, 0], end: [10, 0] })).toThrow();
  });
});

describe('drawEllipse', () => {
  it('center + major + minorRadius → 2 points, 1 ellipse', () => {
    const factory = makeCounterIdFactory();
    const result = drawEllipse(
      emptyEditorState(),
      { center: [0, 0], major: [10, 0], minorRadius: 3 },
      { idFactory: factory },
    );
    expect(result.state.points.size).toBe(2);
    expect(result.state.geometries.size).toBe(1);
    const ellipse = result.state.geometries.get(result.ellipseId) as SketchEllipse;
    expect(ellipse.type).toBe('ellipse');
    expect(ellipse.minorRadius).toBe(3);
    expect(ellipse.centerId).toBe(result.centerId);
    expect(ellipse.majorId).toBe(result.majorId);
  });

  it('rejects non-positive minorRadius', () => {
    expect(() => drawEllipse(emptyEditorState(),
      { center: [0, 0], major: [10, 0], minorRadius: 0 })).toThrow();
    expect(() => drawEllipse(emptyEditorState(),
      { center: [0, 0], major: [10, 0], minorRadius: -1 })).toThrow();
  });
});

describe('drawSpline', () => {
  it('N points → N points + 1 spline, point ids preserved in order', () => {
    const factory = makeCounterIdFactory();
    const result = drawSpline(
      emptyEditorState(),
      [[0, 0], [5, 5], [10, 0], [15, 5]],
      { idFactory: factory },
    );
    expect(result.state.points.size).toBe(4);
    expect(result.state.geometries.size).toBe(1);
    expect(result.pointIds).toHaveLength(4);
    const spline = result.state.geometries.get(result.splineId) as SketchSpline;
    expect(spline.type).toBe('spline');
    expect(spline.pointIds).toEqual(result.pointIds);
  });

  it('rejects fewer than 2 points', () => {
    expect(() => drawSpline(emptyEditorState(), [])).toThrow();
    expect(() => drawSpline(emptyEditorState(), [[0, 0]])).toThrow();
  });
});

describe('drawPoint', () => {
  it('standalone point → 1 point + 1 point geometry, construction flag round-trips', () => {
    const factory = makeCounterIdFactory();
    const result = drawPoint(emptyEditorState(), [5, 5], { idFactory: factory, construction: true });
    expect(result.state.points.size).toBe(1);
    expect(result.state.geometries.size).toBe(1);
    const geom = result.state.geometries.get(result.geometryId) as SketchStandalonePoint;
    expect(geom.type).toBe('point');
    expect(geom.pointId).toBe(result.pointId);
    expect(geom.construction).toBe(true);
  });
});

// =============================================================================
// drawLine flag gaps — distinctStart / distinctEnd (chain model)
// =============================================================================

describe('drawLine — distinctStart / distinctEnd flags', () => {
  it('distinctStart at coord matching an existing point allocates a fresh point id', () => {
    const factory = makeCounterIdFactory();
    // Pre-existing point at (0, 0).
    const pre = addPoint(emptyEditorState(), 0, 0, { idFactory: factory });
    const result = drawLine(pre.state, [0, 0], [10, 0], {
      idFactory: factory,
      distinctStart: true,
    });
    expect(result.startId).not.toBe(pre.id);
    const ptsAtOrigin = Array.from(result.state.points.values()).filter((p) => p.x === 0 && p.y === 0);
    expect(ptsAtOrigin.length).toBe(2);
  });

  it('distinctEnd likewise allocates a fresh end point', () => {
    const factory = makeCounterIdFactory();
    const pre = addPoint(emptyEditorState(), 10, 0, { idFactory: factory });
    const result = drawLine(pre.state, [0, 0], [10, 0], {
      idFactory: factory,
      distinctEnd: true,
    });
    expect(result.endId).not.toBe(pre.id);
    const ptsAt10 = Array.from(result.state.points.values()).filter((p) => p.x === 10 && p.y === 0);
    expect(ptsAt10.length).toBe(2);
  });

  it('2-segment chain — 2 lines with distinctStart on 2nd + explicit coincident', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const l1 = drawLine(state, [0, 0], [10, 0], { idFactory: factory });
    state = l1.state;
    const l2 = drawLine(state, [10, 0], [10, 10], { idFactory: factory, distinctStart: true });
    state = l2.state;
    const coincident = addConstraint(
      state,
      { type: 'coincident', pointA: l1.endId, pointB: l2.startId },
      { idFactory: factory },
    );
    state = coincident.state;
    expect(state.points.size).toBe(4);
    expect(state.geometries.size).toBe(2);
    expect(state.constraints.size).toBe(1);
    expect(l1.endId).not.toBe(l2.startId);
  });
});

// =============================================================================
// Cross-entity snapping & coincidence on draw — implicit merge by coords.
// `findOrCreatePoint` is the engine: when a new tool would create a point at
// the same coords as an existing one, the id is reused — no synthetic
// coincident constraint needed (the coincidence IS the shared id).
// =============================================================================

describe('drawLine — snap to existing reference points', () => {
  it('line from coord matching circle center → reuses circle.centerId, no new constraint', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const c = drawCircle(state, { center: [0, 0], radius: 5 }, { idFactory: factory });
    state = c.state;
    const beforePoints = state.points.size;
    const beforeConstraints = state.constraints.size;
    const line = drawLine(state, [0, 0], [10, 0], { idFactory: factory });
    state = line.state;
    expect(line.startId).toBe(c.centerId);
    expect(state.points.size).toBe(beforePoints + 1); // only the end point is new
    expect(state.constraints.size).toBe(beforeConstraints);
  });

  it('line from rectangle corner reuses ONE of the 2 corner endpoint ids (endpoint asymmetry)', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const rect = drawRectangle(state, { corner: [0, 0], width: 10, height: 5 }, { idFactory: factory });
    state = rect.state;
    // Rectangle's bottom-right corner (10, 0) is held by 2 distinct points
    // (rightStart + bottomEnd); findOrCreatePoint picks whichever it scans
    // first.
    const line = drawLine(state, [10, 0], [20, 0], { idFactory: factory });
    expect([rect.points.bottomEnd, rect.points.rightStart]).toContain(line.startId);
    const lineCoincidents = Array.from(line.state.constraints.values())
      .filter((c): c is Extract<SketchConstraint, { type: 'coincident' }> => c.type === 'coincident')
      .filter((c) => c.pointA === line.startId || c.pointB === line.startId);
    // The rectangle adds 4 corner coincidents; the line itself adds nothing.
    expect(lineCoincidents.length).toBeLessThanOrEqual(1);
  });

  it('line from coord matching another line endpoint shares the endpoint id', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const l1 = drawLine(state, [0, 0], [10, 0], { idFactory: factory });
    state = l1.state;
    const l2 = drawLine(state, [10, 0], [10, 10], { idFactory: factory });
    state = l2.state;
    expect(l2.startId).toBe(l1.endId);
    expect(state.constraints.size).toBe(0);
  });

  it('line with BOTH endpoints snapping reuses both ids, no new points', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const c1 = drawCircle(state, { center: [0, 0], radius: 1 }, { idFactory: factory });
    state = c1.state;
    const c2 = drawCircle(state, { center: [10, 0], radius: 1 }, { idFactory: factory });
    state = c2.state;
    const beforePts = state.points.size;
    const line = drawLine(state, [0, 0], [10, 0], { idFactory: factory });
    state = line.state;
    expect(line.startId).toBe(c1.centerId);
    expect(line.endId).toBe(c2.centerId);
    expect(state.points.size).toBe(beforePts);
  });

  // Three roadmap markers — these track snap behaviours we don't have
  // yet. `it.fails` makes them green when they fail
  // (intentional gap) and red when they start passing (gap closed —
  // edit the test to assert the new behavior).
  it.fails('ROADMAP: line endpoint on circle circumference should add pointOnCircle', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const c = drawCircle(state, { center: [0, 0], radius: 5 }, { idFactory: factory });
    state = c.state;
    // (5, 0) sits exactly on the circle (radius 5).
    const line = drawLine(state, [5, 0], [15, 0], { idFactory: factory });
    state = line.state;
    const pointOnCircles = Array.from(state.constraints.values())
      .filter((co) => co.type === 'pointOnCircle');
    expect(pointOnCircles).toHaveLength(1);
  });

  it.fails('ROADMAP: line endpoint at midpoint of existing line should add midpoint', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const base = drawLine(state, [0, 0], [10, 0], { idFactory: factory });
    state = base.state;
    const line = drawLine(state, [5, 0], [5, 10], { idFactory: factory });
    state = line.state;
    const midpoints = Array.from(state.constraints.values())
      .filter((co) => co.type === 'midpoint');
    expect(midpoints).toHaveLength(1);
  });

  it.fails('ROADMAP: line endpoint on interior of existing line should add pointOnLine', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const base = drawLine(state, [0, 0], [10, 0], { idFactory: factory });
    state = base.state;
    // (3, 0) sits on `base` but is neither endpoint nor midpoint.
    const line = drawLine(state, [3, 0], [3, 10], { idFactory: factory });
    state = line.state;
    const pointOnLines = Array.from(state.constraints.values())
      .filter((co) => co.type === 'pointOnLine');
    expect(pointOnLines).toHaveLength(1);
  });
});

describe('drawCircle / drawArc — center snapping', () => {
  it('drawCircle with center matching existing point reuses the id', () => {
    const factory = makeCounterIdFactory();
    const pre = addPoint(emptyEditorState(), 5, 5, { idFactory: factory });
    const result = drawCircle(pre.state, { center: [5, 5], radius: 3 }, { idFactory: factory });
    expect(result.centerId).toBe(pre.id);
    expect(result.state.points.size).toBe(1);
  });

  it('drawCircle on another circle\'s center reuses id (concentric by construction)', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const outer = drawCircle(state, { center: [0, 0], radius: 10 }, { idFactory: factory });
    state = outer.state;
    const inner = drawCircle(state, { center: [0, 0], radius: 3 }, { idFactory: factory });
    expect(inner.centerId).toBe(outer.centerId);
    // Shared center id IS the concentric relationship; no explicit constraint
    // needed (and `concentric` would be redundant — V3 covers the post-hoc
    // case where centres are separate and the user asks for concentricity).
    expect(inner.state.constraints.size).toBe(0);
  });

  it('drawArc with center matching circle center reuses id; start/end fresh', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const c = drawCircle(state, { center: [0, 0], radius: 5 }, { idFactory: factory });
    state = c.state;
    const beforePts = state.points.size;
    const arc = drawArc(state, {
      center: [0, 0], radius: 3, startAngle: 0, endAngle: Math.PI / 2,
    }, { idFactory: factory });
    expect(arc.centerId).toBe(c.centerId);
    expect(arc.state.points.size).toBe(beforePts + 2); // start + end are new
  });

  it.fails('ROADMAP: drawCircle with center on existing circle\'s circumference should add pointOnCircle', () => {
    const factory = makeCounterIdFactory();
    let state = emptyEditorState();
    const outer = drawCircle(state, { center: [0, 0], radius: 10 }, { idFactory: factory });
    state = outer.state;
    // New circle's center at (10, 0) — on outer's circumference.
    const inner = drawCircle(state, { center: [10, 0], radius: 2 }, { idFactory: factory });
    state = inner.state;
    const pointOnCircles = Array.from(state.constraints.values())
      .filter((co) => co.type === 'pointOnCircle');
    expect(pointOnCircles).toHaveLength(1);
  });
});

// =============================================================================
// addConstraint — persistence smoke for every variant in the union.
// Single shape test per kind — the solver-residual behavior is exercised by
// src/sketch/solver/planegcsConstraints.test.ts. This block guards against
// schema drift (a new constraint kind that adders allow but the
// constraint-input union rejects, or vice versa).
// =============================================================================

describe('addConstraint persists every constraint variant', () => {
  // Shared fixture: 2 lines + 2 circles + 1 arc to reference.
  const makeFixture = () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const l1 = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = l1.state;
    const l2 = drawLine(s, [0, 5], [10, 5], { idFactory: factory }); s = l2.state;
    const c1 = drawCircle(s, { center: [20, 0], radius: 3 }, { idFactory: factory }); s = c1.state;
    const c2 = drawCircle(s, { center: [30, 0], radius: 3 }, { idFactory: factory }); s = c2.state;
    const arc = drawArc(s,
      { center: [40, 0], radius: 2, startAngle: 0, endAngle: Math.PI / 2 },
      { idFactory: factory },
    );
    s = arc.state;
    return { state: s, l1, l2, c1, c2, arc, factory };
  };

  const persists = (input: SketchConstraintInput, expectedType: SketchConstraint['type']) => {
    const f = makeFixture();
    const result = addConstraint(f.state, input, { idFactory: f.factory });
    const stored = result.state.constraints.get(result.id);
    expect(stored).toBeDefined();
    expect(stored?.type).toBe(expectedType);
  };

  it('coincident', () => {
    const f = makeFixture();
    persists({ type: 'coincident', pointA: f.l1.startId, pointB: f.l2.startId }, 'coincident');
  });
  it('horizontal', () => {
    const f = makeFixture();
    persists({ type: 'horizontal', geometryId: f.l1.lineId }, 'horizontal');
  });
  it('vertical', () => {
    const f = makeFixture();
    persists({ type: 'vertical', geometryId: f.l1.lineId }, 'vertical');
  });
  it('fixed', () => {
    const f = makeFixture();
    persists({ type: 'fixed', pointId: f.l1.startId, x: 0, y: 0 }, 'fixed');
  });
  it('distance', () => {
    const f = makeFixture();
    persists({ type: 'distance', pointA: f.l1.startId, pointB: f.l1.endId, value: 10 }, 'distance');
  });
  it('distanceX', () => {
    const f = makeFixture();
    persists({ type: 'distanceX', pointA: f.l1.startId, pointB: f.l1.endId, value: 10 }, 'distanceX');
  });
  it('distanceY', () => {
    const f = makeFixture();
    persists({ type: 'distanceY', pointA: f.l1.startId, pointB: f.l2.startId, value: 5 }, 'distanceY');
  });
  it('radius', () => {
    const f = makeFixture();
    persists({ type: 'radius', geometryId: f.c1.circleId, value: 3 }, 'radius');
  });
  it('length', () => {
    const f = makeFixture();
    persists({ type: 'length', geometryId: f.l1.lineId, value: 10 }, 'length');
  });
  it('parallel', () => {
    const f = makeFixture();
    persists({ type: 'parallel', geometryA: f.l1.lineId, geometryB: f.l2.lineId }, 'parallel');
  });
  it('perpendicular', () => {
    const f = makeFixture();
    persists({ type: 'perpendicular', geometryA: f.l1.lineId, geometryB: f.l2.lineId }, 'perpendicular');
  });
  it('angle', () => {
    const f = makeFixture();
    persists(
      { type: 'angle', geometryA: f.l1.lineId, geometryB: f.l2.lineId, value: Math.PI / 4 },
      'angle',
    );
  });
  it('tangent (line-circle)', () => {
    const f = makeFixture();
    persists({ type: 'tangent', lineId: f.l1.lineId, circleId: f.c1.circleId }, 'tangent');
  });
  it('tangent (circle-circle external)', () => {
    const f = makeFixture();
    persists(
      { type: 'tangent', circleId: f.c1.circleId, secondCircleId: f.c2.circleId, internal: false },
      'tangent',
    );
  });
  it('tangent (circle-circle internal)', () => {
    const f = makeFixture();
    persists(
      { type: 'tangent', circleId: f.c1.circleId, secondCircleId: f.c2.circleId, internal: true },
      'tangent',
    );
  });
  it('pointOnLine', () => {
    const f = makeFixture();
    persists({ type: 'pointOnLine', pointId: f.l2.startId, geometryId: f.l1.lineId }, 'pointOnLine');
  });
  it('pointOnCircle', () => {
    const f = makeFixture();
    persists({ type: 'pointOnCircle', pointId: f.l1.startId, geometryId: f.c1.circleId }, 'pointOnCircle');
  });
  it('symmetric', () => {
    const f = makeFixture();
    persists(
      { type: 'symmetric', pointA: f.l1.startId, pointB: f.l2.startId, geometryId: f.l1.lineId },
      'symmetric',
    );
  });
  it('equal (line-line)', () => {
    const f = makeFixture();
    persists({ type: 'equal', geometryA: f.l1.lineId, geometryB: f.l2.lineId }, 'equal');
  });
  it('equal (circle-circle)', () => {
    const f = makeFixture();
    persists({ type: 'equal', geometryA: f.c1.circleId, geometryB: f.c2.circleId }, 'equal');
  });
  // V3 — concentric on circles/arcs.
  it('concentric', () => {
    const f = makeFixture();
    persists({ type: 'concentric', geometryA: f.c1.circleId, geometryB: f.c2.circleId }, 'concentric');
  });
  // V5 — midpoint (point on midpoint of a line).
  it('midpoint', () => {
    const f = makeFixture();
    // A standalone point pinned to the midpoint of l1.
    const mid = addPoint(f.state, 5, 0, { idFactory: f.factory });
    const result = addConstraint(
      mid.state,
      { type: 'midpoint', pointId: mid.id, geometryId: f.l1.lineId },
      { idFactory: f.factory },
    );
    const stored = result.state.constraints.get(result.id);
    expect(stored?.type).toBe('midpoint');
  });
});

// =============================================================================
// concentric + midpoint round-trip through snapshot
// =============================================================================

describe('snapshot round-trip — V3 concentric + V5 midpoint', () => {
  it('concentric round-trips', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const c1 = drawCircle(s, { center: [0, 0], radius: 5 }, { idFactory: factory }); s = c1.state;
    const c2 = drawCircle(s, { center: [10, 0], radius: 3 }, { idFactory: factory }); s = c2.state;
    s = addConstraint(
      s,
      { type: 'concentric', geometryA: c1.circleId, geometryB: c2.circleId },
      { idFactory: factory },
    ).state;
    const restored = fromSnapshot(toSnapshot(s));
    const concs = Array.from(restored.constraints.values()).filter((c) => c.type === 'concentric');
    expect(concs).toHaveLength(1);
  });

  it('midpoint round-trips', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const line = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = line.state;
    const mid = addPoint(s, 5, 0, { idFactory: factory }); s = mid.state;
    s = addConstraint(
      s,
      { type: 'midpoint', pointId: mid.id, geometryId: line.lineId },
      { idFactory: factory },
    ).state;
    const restored = fromSnapshot(toSnapshot(s));
    const mids = Array.from(restored.constraints.values()).filter((c) => c.type === 'midpoint');
    expect(mids).toHaveLength(1);
  });
});

// =============================================================================
// movePoint
// =============================================================================

describe('movePoint', () => {
  it('moves point coords without touching geometries or constraints', () => {
    const factory = makeCounterIdFactory();
    const line = drawLine(emptyEditorState(), [0, 0], [10, 0], { idFactory: factory });
    const beforeGeoms = line.state.geometries;
    const beforeCons = line.state.constraints;
    const moved = movePoint(line.state, line.startId, [3, 3]);
    const pt = moved.state.points.get(line.startId)!;
    expect(pt.x).toBe(3);
    expect(pt.y).toBe(3);
    // Geometries + constraints map references unchanged (no mutation).
    expect(moved.state.geometries).toBe(beforeGeoms);
    expect(moved.state.constraints).toBe(beforeCons);
  });

  it('moving a point referenced by a line changes the endpoint implicitly', () => {
    const factory = makeCounterIdFactory();
    const line = drawLine(emptyEditorState(), [0, 0], [10, 0], { idFactory: factory });
    const moved = movePoint(line.state, line.endId, [20, 0]);
    const endPt = moved.state.points.get(line.endId)!;
    expect(endPt.x).toBe(20);
    const lineGeom = moved.state.geometries.get(line.lineId) as SketchLineSegment;
    expect(lineGeom.endId).toBe(line.endId);
  });

  it('throws when point id does not exist', () => {
    const state = emptyEditorState();
    expect(() => movePoint(state, sketchPointId('does_not_exist'), [0, 0])).toThrow();
  });

  /**
   * The sketch origin is a fixed point, and `findOrCreatePoint` merges by
   * position without excluding it — so a circle drawn on the origin takes
   * `pt_origin` as its centre. That merge is wanted (the circle is anchored,
   * two DOF gone), but dragging the circle used to drag the origin with it:
   * the anchor ended up somewhere arbitrary, `con_origin_fixed` became
   * unsatisfiable, and DOF could never reach zero again.
   */
  it('refuses to move a fixed point', () => {
    let state = emptyEditorState();
    const points = new Map(state.points);
    const pinned = sketchPointId('pt_pinned');
    points.set(pinned, { id: pinned, x: 0, y: 0, fixed: true });
    state = { ...state, points };

    const result = movePoint(state, pinned, [40, 25]);
    expect(result.state.points.get(pinned)).toMatchObject({ x: 0, y: 0 });
    // Unchanged means unchanged — callers may rely on identity to skip work.
    expect(result.state).toBe(state);
  });

  it('still moves an unfixed point', () => {
    let state = emptyEditorState();
    const points = new Map(state.points);
    const free = sketchPointId('pt_free');
    points.set(free, { id: free, x: 0, y: 0, fixed: false });
    state = { ...state, points };

    const result = movePoint(state, free, [40, 25]);
    expect(result.state.points.get(free)).toMatchObject({ x: 40, y: 25 });
  });
});

/**
 * Every constraint reference in the state that names a point or geometry
 * the state no longer holds. planegcs resolves each reference by id when
 * it builds the system and throws `sketch object <id> not found` on a
 * miss, so a non-empty result here is a crash on the next solve.
 *
 * Hand-rolled over the field names rather than reusing the module's own
 * `constraintReferencesGeometry`: a test that shares the production
 * predicate can't see a reference the predicate itself forgot, which is
 * exactly how `concentric` and `midpoint` went unnoticed.
 */
function danglingRefs(state: EditorState): string[] {
  const bad: string[] = [];
  const geomKeys = ['geometryId', 'geometryA', 'geometryB', 'lineId', 'circleId', 'secondCircleId'];
  const pointKeys = ['pointId', 'pointA', 'pointB'];
  for (const c of state.constraints.values()) {
    const rec = c as unknown as Record<string, unknown>;
    for (const key of geomKeys) {
      const v = rec[key];
      if (typeof v === 'string' && !state.geometries.has(v as never)) {
        bad.push(`${c.type}.${key} → missing geometry ${v}`);
      }
    }
    for (const key of pointKeys) {
      const v = rec[key];
      if (typeof v === 'string' && !state.points.has(v as never)) {
        bad.push(`${c.type}.${key} → missing point ${v}`);
      }
    }
  }
  return bad;
}

describe('removeGeometry — constraint cascade', () => {
  it('drops a concentric constraint when one of its circles goes', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const inner = drawCircle(s, { center: [0, 0], radius: 2 }, { idFactory: factory }); s = inner.state;
    const outer = drawCircle(s, { center: [0, 0], radius: 8 }, { idFactory: factory }); s = outer.state;
    const con = addConstraint(
      s,
      { type: 'concentric', geometryA: inner.circleId, geometryB: outer.circleId },
      { idFactory: factory },
    );
    s = con.state;

    const { state } = removeGeometry(s, outer.circleId);
    expect(state.constraints.has(con.id)).toBe(false);
    expect(danglingRefs(state)).toEqual([]);
  });

  it('drops a midpoint constraint when its line goes', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const line = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = line.state;
    const mid = drawPoint(s, [5, 0], { idFactory: factory }); s = mid.state;
    const con = addConstraint(
      s,
      { type: 'midpoint', pointId: mid.pointId, geometryId: line.lineId },
      { idFactory: factory },
    );
    s = con.state;

    const { state } = removeGeometry(s, line.lineId);
    expect(state.constraints.has(con.id)).toBe(false);
    expect(danglingRefs(state)).toEqual([]);
  });

  it('drops a constraint left pointing at a point the removal orphaned', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    // `wall` survives; `probe` is deleted and owns the constrained point.
    const wall = drawLine(s, [0, 0], [0, 10], { idFactory: factory }); s = wall.state;
    const probe = drawLine(s, [5, 5], [9, 5], { idFactory: factory }); s = probe.state;
    const con = addConstraint(
      s,
      { type: 'pointOnLine', pointId: probe.endId, geometryId: wall.lineId },
      { idFactory: factory },
    );
    s = con.state;

    const { state } = removeGeometry(s, probe.lineId);
    expect(state.geometries.has(wall.lineId)).toBe(true);
    expect(state.points.has(probe.endId)).toBe(false);
    expect(state.constraints.has(con.id)).toBe(false);
    expect(danglingRefs(state)).toEqual([]);
  });

  it('keeps a shared corner and the constraints on the surviving edge', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    const bottom = drawLine(s, [0, 0], [10, 0], { idFactory: factory }); s = bottom.state;
    const right = drawLine(s, [10, 0], [10, 10], { idFactory: factory }); s = right.state;
    const keep = addConstraint(s, { type: 'vertical', geometryId: right.lineId }, { idFactory: factory });
    s = keep.state;

    const { state } = removeGeometry(s, bottom.lineId);
    // The corner is still an endpoint of `right`, so it must not be GC'd.
    expect(state.points.has(bottom.endId)).toBe(true);
    expect(state.constraints.has(keep.id)).toBe(true);
    expect(danglingRefs(state)).toEqual([]);
  });
});
