/**
 * Tests for the arc-segment midpoint logic in `regionSegmentsToWire`.
 *
 * The midpoint determines which side of the arc `makeArcEdge` picks. Pick
 * the wrong side and OCCT builds the major arc instead of the minor —
 * which manifests as a "full circle" instead of a corner wedge in the
 * extruded body (the user-visible regression we hit on the
 * rect+inscribed-circle demo).
 */

import { describe, expect, it } from 'vitest';
import { regionSegmentsToWire } from './wireProfile.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
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
  it('picks the minor-arc midpoint when raw sweep is +π/2 (CCW short)', () => {
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

  it('picks the minor-arc midpoint when raw sweep is +3π/2 (CCW long way reported)', () => {
    // Same quarter arc but the graph reported the angles the long way:
    // start at (1,0) angle 0, end at (0,1) angle 5π/2 → sweep raw = 5π/2
    // normalized to (-π,π] becomes π/2 → midpoint stays on the minor
    // arc at (√2/2, √2/2).
    //
    // This is the exact regression case from the rect+inscribed-circle
    // demo: the planar graph reports arc angles in the CCW-around-circle
    // direction even when the face traverses the arc the short way; the
    // normalization in `regionSegmentsToWire` rescues the midpoint.
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        makeArcSegment({
          start: [1, 0],
          end: [0, 1],
          center: [0, 0],
          radius: 1,
          startAngle: 0,
          endAngle: (5 * Math.PI) / 2, // == π/2 mod 2π, but raw value is large
        }),
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    expect(wire).toHaveLength(1);
    const seg = wire[0]!;
    if (seg.kind !== 'arc3pt') throw new Error('expected arc3pt');
    expect(seg.mid[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(seg.mid[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('picks the minor-arc midpoint for a CW-traversed quarter (-π/2)', () => {
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

  it('regression: rect+inscribed-circle bottom-left corner arc midpoint', () => {
    // Lifted from the appInit demo + the planar-graph diagnostic output.
    // Arc bounds the bottom-left corner region (interior at (-18,-32) in
    // sketch coords, sketch on XZ plane in the demo but we test on XY
    // here — same shape, just relabeled axes). The corner is below-left
    // of the circle center, so the minor arc midpoint should land in the
    // bottom-left quadrant of the circle ≈ (-14.14, -64.14).
    //
    // Planar graph reports: start=(0,-70) angle -π/2,
    //                      end=(-20,-50)  angle  π,
    //                      sweep raw = π - (-π/2) = 3π/2.
    // Without normalization → midAngle = π/4 → (14.14, -35.86) (top-RIGHT, wrong corner).
    // With (-π,π] normalize  → sweep = -π/2 → midAngle = -3π/4 → (-14.14, -64.14) ✓.
    const region: Pick<SketchRegion, 'segments'> = {
      segments: [
        makeArcSegment({
          start: [0, -70],
          end: [-20, -50],
          center: [0, -50],
          radius: 20,
          startAngle: -Math.PI / 2,
          endAngle: Math.PI,
        }),
      ],
    };
    const wire = regionSegmentsToWire(region as SketchRegion, xyPlane);
    const seg = wire[0]!;
    if (seg.kind !== 'arc3pt') throw new Error('expected arc3pt');
    expect(seg.mid[0]).toBeCloseTo(-14.14, 1);
    expect(seg.mid[1]).toBeCloseTo(-64.14, 1);
  });
});
