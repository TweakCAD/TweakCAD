/**
 * Tests for the arc-segment midpoint logic in `regionSegmentsToWire`.
 *
 * The midpoint determines which side of the arc `makeArcEdge` picks. Pick
 * the wrong side and OCCT builds the complementary arc — a corner wedge
 * becomes most of a circle, or a major arc collapses to its minor one.
 * Segments carry the signed traversal sweep as
 * `arcEndAngle - arcStartAngle`, so the midpoint is taken from it as-is.
 */

import { describe, expect, it } from 'vitest';
import { regionSegmentsToWire } from './wireProfile.ts';
import { detectSketchRegions } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchEntity } from '@tweakcad/core/src/document/schema.ts';
import { entityId } from '@tweakcad/core/src/ids.ts';
import type { EntityId } from '@tweakcad/core/src/ids.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';

const xyPlane = {
  name: 'XY' as const,
  origin: [0, 0, 0] as Vec3,
  uAxis: [1, 0, 0] as Vec3,
  vAxis: [0, 1, 0] as Vec3,
  normal: [0, 0, 1] as Vec3,
};

function makeArcSegment(opts: {
  start: [number, number];
  end: [number, number];
  center: [number, number];
  radius: number;
  startAngle: number;
  endAngle: number;
}): SketchRegion['segments'][number] {
  return {
    entityId: 'arc' as EntityId,
    reversed: false,
    kind: 'arc',
    start: opts.start,
    end: opts.end,
    arcCenter: opts.center,
    arcRadius: opts.radius,
    arcStartAngle: opts.startAngle,
    arcEndAngle: opts.endAngle,
  };
}

describe('regionSegmentsToWire — arc midpoint', () => {
  it('takes the midpoint of a +π/2 sweep (CCW quarter)', () => {
    // Quarter arc on unit circle from (1,0) to (0,1) — midpoint should
    // be (√2/2, √2/2), NOT (-√2/2, -√2/2).
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        makeArcSegment({
          start: [1, 0],
          end: [0, 1],
          center: [0, 0],
          radius: 1,
          startAngle: 0,
          endAngle: Math.PI / 2,
        }),
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    expect(wire).toHaveLength(1);
    const seg = wire[0]!;
    expect(seg.kind).toBe('arc3pt');
    if (seg.kind !== 'arc3pt') return;
    expect(seg.mid[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(seg.mid[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('keeps a +3π/2 sweep on its long side', () => {
    // Major arc on the unit circle from (1,0) CCW round to (0,-1): the
    // midpoint sits at 3π/4, not on the quarter between the endpoints.
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        makeArcSegment({
          start: [1, 0],
          end: [0, -1],
          center: [0, 0],
          radius: 1,
          startAngle: 0,
          endAngle: (3 * Math.PI) / 2,
        }),
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    expect(wire).toHaveLength(1);
    const seg = wire[0]!;
    if (seg.kind !== 'arc3pt') throw new Error('expected arc3pt');
    expect(seg.mid[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(seg.mid[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('takes the midpoint of a CW-traversed quarter (-π/2)', () => {
    // Quarter arc from (0,1) to (1,0) going CW around the circle.
    // sweep raw = -π/2, midpoint should be at (√2/2, √2/2) — same
    // minor arc, opposite traversal direction.
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        makeArcSegment({
          start: [0, 1],
          end: [1, 0],
          center: [0, 0],
          radius: 1,
          startAngle: Math.PI / 2,
          endAngle: 0,
        }),
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    const seg = wire[0]!;
    if (seg.kind !== 'arc3pt') throw new Error('expected arc3pt');
    expect(seg.mid[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(seg.mid[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('keeps a reversed half-circle (sweep = −π) on the correct side', () => {
    // Regression: a "D" profile whose right-bulging half-circle arc is
    // walked end→start by the curve-loop walker yields startAngle π/2,
    // endAngle −π/2 → raw sweep −π. The midpoint must stay at (20,20)
    // (right bulge), NOT flip to (−20,20). An asymmetric (−π,π] interval
    // wrapped −π→+π and extruded the body as a left-bulging half-disc.
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        makeArcSegment({
          start: [0, 40],
          end: [0, 0],
          center: [0, 20],
          radius: 20,
          startAngle: Math.PI / 2,
          endAngle: -Math.PI / 2,
        }),
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    const seg = wire[0]!;
    if (seg.kind !== 'arc3pt') throw new Error('expected arc3pt');
    expect(seg.mid[0]).toBeCloseTo(20, 6); // right bulge, not -20
    expect(seg.mid[1]).toBeCloseTo(20, 6);
  });

  it('maps a bezier segment to a native four-pole Bézier wire edge', () => {
    // Poles are already oriented by the curve-loop walker — map straight
    // through to world space on the XY plane (identity here).
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        {
          entityId: 'b' as EntityId,
          reversed: false,
          kind: 'bezier',
          start: [0, 0],
          end: [10, 0],
          bezierCp1: [0, 10],
          bezierCp2: [10, 10],
        },
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    expect(wire).toHaveLength(1);
    const seg = wire[0]!;
    expect(seg.kind).toBe('bezier');
    if (seg.kind !== 'bezier') return;
    expect(seg.start).toEqual([0, 0, 0]);
    expect(seg.cp1).toEqual([0, 10, 0]);
    expect(seg.cp2).toEqual([10, 10, 0]);
    expect(seg.end).toEqual([10, 0, 0]);
  });

  it('maps a spline segment to a sampled interpolated wire edge', () => {
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        {
          entityId: 's' as EntityId,
          reversed: false,
          kind: 'spline',
          start: [0, 0],
          end: [10, 0],
          splinePoints: [[0, 0], [3, 5], [7, 5], [10, 0]],
        },
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    expect(wire).toHaveLength(1);
    const seg = wire[0]!;
    expect(seg.kind).toBe('spline');
    if (seg.kind !== 'spline') return;
    // Catmull-Rom sampling yields more points than the 4 control points,
    // and the curve passes through the first/last control point in world.
    expect(seg.points.length).toBeGreaterThan(4);
    expect(seg.points[0]).toEqual([0, 0, 0]);
    expect(seg.points[seg.points.length - 1]).toEqual([10, 0, 0]);
  });

});

/** Arc segment of the region whose entity set is exactly `ids`. */
function arcMidOf(entities: Record<string, SketchEntity>, ids: string[]): Vec3 {
  const region = detectSketchRegions(entities).find(r => {
    const set = new Set(r.entityIds.map(String));
    return set.size === ids.length && ids.every(id => set.has(id));
  });
  if (!region) throw new Error(`no region for ${ids.join('|')}`);
  const arcs = regionSegmentsToWire(region, xyPlane).filter(s => s.kind === 'arc3pt');
  expect(arcs).toHaveLength(1);
  const seg = arcs[0]!;
  if (seg.kind !== 'arc3pt') throw new Error('expected arc3pt');
  return seg.mid;
}

function line(id: string, start: [number, number], end: [number, number]): SketchEntity {
  return { id: entityId(id), type: 'line', start: [String(start[0]), String(start[1])], end: [String(end[0]), String(end[1])] };
}

describe('regionSegmentsToWire — arcs from detected regions', () => {
  it('rect + inscribed circle: the bottom-left corner arc bulges into that corner', () => {
    // Planar-graph arc piece bounding the corner below-left of the circle
    // centre; its midpoint is at angle −3π/4 ≈ (−14.14, −64.14).
    const entities: Record<string, SketchEntity> = {
      rect_bottom: line('rect_bottom', [-20, -70], [20, -70]),
      rect_right: line('rect_right', [20, -70], [20, -30]),
      rect_top: line('rect_top', [20, -30], [-20, -30]),
      rect_left: line('rect_left', [-20, -30], [-20, -70]),
      circle: { id: entityId('circle'), type: 'circle', center: ['0', '-50'], diameter: '40' },
    };
    const mid = arcMidOf(entities, ['rect_bottom', 'rect_left', 'circle']);
    expect(mid[0]).toBeCloseTo(-14.14, 1);
    expect(mid[1]).toBeCloseTo(-64.14, 1);
  });

  it('circle cut by a rectangle edge: the 240° piece keeps its major arc', () => {
    // Circle r=10 at the origin, rectangle edge along x=5. The piece left
    // of the edge is bounded by a 240° arc whose midpoint is (−10, 0); the
    // minor-arc midpoint would be (10, 0), inside the lens.
    const entities: Record<string, SketchEntity> = {
      circle: { id: entityId('circle'), type: 'circle', center: ['0', '0'], diameter: '20' },
      b: line('b', [5, -20], [25, -20]),
      r: line('r', [25, -20], [25, 20]),
      t: line('t', [25, 20], [5, 20]),
      l: line('l', [5, 20], [5, -20]),
    };
    const mid = arcMidOf(entities, ['circle', 'l']);
    expect(mid[0]).toBeCloseTo(-10, 6);
    expect(mid[1]).toBeCloseTo(0, 6);
  });

  it('sketch arc over 180° closed by a chord keeps its major arc', () => {
    // 270° sketch arc CCW from π/2 to 2π (r=10), closed by a line from
    // (10,0) back to (0,10). Midpoint of the arc is at 5π/4.
    const entities: Record<string, SketchEntity> = {
      arc: {
        id: entityId('arc'), type: 'arc', center: ['0', '0'], radius: '10',
        startAngle: String(Math.PI / 2), endAngle: String(2 * Math.PI),
      },
      chord: line('chord', [10, 0], [0, 10]),
    };
    const mid = arcMidOf(entities, ['arc', 'chord']);
    expect(mid[0]).toBeCloseTo(-10 * Math.SQRT1_2, 6);
    expect(mid[1]).toBeCloseTo(-10 * Math.SQRT1_2, 6);
  });
});
