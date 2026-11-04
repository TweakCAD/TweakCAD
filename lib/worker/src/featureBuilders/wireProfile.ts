/**
 * Shared helpers for converting a SketchRegion's segments into kernel
 * `WireSegment[]`. Used by every builder that turns a 2D profile into a
 * 3D solid (extrude / revolve / loft) so a fillet or arc on a sketch
 * boundary becomes a real BREP arc edge, not a polygonalized 64-facet
 * approximation.
 *
 * Each segment kind dispatches to its own conversion, mirroring the
 * polymorphic `toOCCGeometry` pattern: arcs land on OCCT's
 * `GC_MakeArcOfCircle_4` via occt-wasm's `makeArcEdge(start, mid, end)`.
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { catmullRomSpline } from '@tweakcad/core/src/sketch/curveSampling.ts';
import { segmentIdentity } from '@tweakcad/core/src/sketch/provenance.ts';
import type { WireSegment } from '@tweakcad/kernel/src/types.ts';
import type { ResolvedSketchPlaneData } from './buildSketch.ts';
import { DEFAULT_PLANES } from './resolvePlane.ts';

/** Catmull-Rom samples per control-point span when turning a `spline`
 *  boundary into kernel B-spline interpolation points. */
const SPLINE_WIRE_SUBDIVISIONS = 8;

/**
 * Map a sketch-local 2D point through the resolved sketch plane into a
 * world 3D point. Defaults to the XZ plane if no plane data is provided.
 */
export function sketchToWorld(
  point: [number, number],
  plane: ResolvedSketchPlaneData | undefined,
): Vec3 {
  const p = plane ?? DEFAULT_PLANES.XZ;
  return [
    p.origin[0] + point[0] * p.uAxis[0] + point[1] * p.vAxis[0],
    p.origin[1] + point[0] * p.uAxis[1] + point[1] * p.vAxis[1],
    p.origin[2] + point[0] * p.uAxis[2] + point[1] * p.vAxis[2],
  ];
}

/**
 * True iff the region carries a native curve (arc or Bézier) on at least
 * one segment — i.e., the kernel pipeline should switch to the `'wire'`
 * profile path so each curve becomes a real BREP edge. Pure line-loop
 * regions stay on the legacy polygon path (1:1 result topology, slightly
 * cheaper kernel call).
 */
export function regionHasCurveSegments(region: SketchRegion): boolean {
  return region.segments.some(s => s.kind === 'arc' || s.kind === 'bezier' || s.kind === 'spline');
}

/**
 * True iff every segment carries its own geometry, so the region can be built
 * as a `'wire'` profile whose edges each name the segment they came from.
 */
export function regionHasSegmentGeometry(region: SketchRegion): boolean {
  return region.segments.length > 0 && region.segments.every(s => s.start !== undefined && s.end !== undefined);
}

/**
 * Build the kernel-side `WireSegment[]` from a region's per-segment
 * geometry. Each `line` becomes a kernel line; each `arc` becomes a
 * three-point arc via the midpoint of its signed sweep; each
 * `bezier` maps its four poles straight to a native Bézier edge.
 *
 * The mid-point is computed from `arcCenter` + `arcRadius` +
 * `(arcStartAngle, arcEndAngle)` rather than sampling the chord — using
 * a real on-curve midpoint is what makes `GC_MakeArcOfCircle_4`
 * recover the exact circular arc OCCT wants.
 */
export function regionSegmentsToWire(
  region: SketchRegion,
  plane: ResolvedSketchPlaneData | undefined,
): WireSegment[] {
  const out: WireSegment[] = [];
  for (const seg of region.segments) {
    if (!seg.start || !seg.end) continue; // legacy segment with no geometry
    const id = segmentIdentity(seg);
    if (seg.kind === 'spline' && seg.splinePoints !== undefined && seg.splinePoints.length >= 2) {
      // Sample the editor's Catmull-Rom curve through the control points
      // (already oriented in loop order) so the kernel B-spline follows
      // the same shape the user drew, then map the polyline to world.
      const sampled = catmullRomSpline(seg.splinePoints, SPLINE_WIRE_SUBDIVISIONS);
      out.push({
        kind: 'spline',
        points: sampled.map(p => sketchToWorld(p, plane)),
        id,
      });
    } else if (seg.kind === 'bezier' && seg.bezierCp1 !== undefined && seg.bezierCp2 !== undefined) {
      // Cubic Bézier — poles are already oriented in loop order by the
      // curve-loop walker, so map straight through to a native BREP
      // Bézier edge (one lateral face per curve, no polygonalization).
      out.push({
        kind: 'bezier',
        start: sketchToWorld(seg.start, plane),
        cp1: sketchToWorld(seg.bezierCp1, plane),
        cp2: sketchToWorld(seg.bezierCp2, plane),
        end: sketchToWorld(seg.end, plane),
        id,
      });
    } else if (
      seg.kind === 'arc' &&
      seg.arcCenter !== undefined &&
      seg.arcRadius !== undefined &&
      seg.arcStartAngle !== undefined &&
      seg.arcEndAngle !== undefined
    ) {
      const [cx, cy] = seg.arcCenter;
      const r = seg.arcRadius;
      // `arcEndAngle - arcStartAngle` is the signed sweep in traversal
      // order, unwrapped by both region producers (see
      // `SketchRegionSegment.arcEndAngle`). Taking it as-is keeps arcs over
      // 180° on their real side; forcing the minor arc would flip them.
      const sweep = seg.arcEndAngle - seg.arcStartAngle;
      const midAngle = seg.arcStartAngle + sweep / 2;
      const midLocal: [number, number] = [
        cx + r * Math.cos(midAngle),
        cy + r * Math.sin(midAngle),
      ];
      out.push({
        kind: 'arc3pt',
        start: sketchToWorld(seg.start, plane),
        mid: sketchToWorld(midLocal, plane),
        end: sketchToWorld(seg.end, plane),
        id,
      });
    } else {
      out.push({
        kind: 'line',
        start: sketchToWorld(seg.start, plane),
        end: sketchToWorld(seg.end, plane),
        id,
      });
    }
  }
  return out;
}
