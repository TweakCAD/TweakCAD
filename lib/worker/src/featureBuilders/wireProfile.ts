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
import type { WireSegment } from '@tweakcad/kernel/src/types.ts';
import type { ResolvedSketchPlaneData } from './buildSketch.ts';

/**
 * Map a sketch-local 2D point through the resolved sketch plane into a
 * world 3D point. Defaults to the XZ plane if no plane data is provided
 * — same fallback used by buildExtrude / buildRevolve / buildLoft.
 */
export function sketchToWorld(
  point: [number, number],
  plane: ResolvedSketchPlaneData | undefined,
): Vec3 {
  const p = plane ?? {
    name: 'XZ' as const,
    origin: [0, 0, 0] as Vec3,
    uAxis: [1, 0, 0] as Vec3,
    vAxis: [0, 0, 1] as Vec3,
    normal: [0, 1, 0] as Vec3,
  };
  return [
    p.origin[0] + point[0] * p.uAxis[0] + point[1] * p.vAxis[0],
    p.origin[1] + point[0] * p.uAxis[1] + point[1] * p.vAxis[1],
    p.origin[2] + point[0] * p.uAxis[2] + point[1] * p.vAxis[2],
  ];
}

/**
 * True iff the region carries native arc geometry on at least one
 * segment — i.e., the kernel pipeline should switch to the `'wire'`
 * profile path. Pure line-loop regions can stay on the legacy polygon
 * path (1:1 result topology, slightly cheaper kernel call).
 */
export function regionHasArcSegments(region: SketchRegion): boolean {
  return region.segments.some(s => s.kind === 'arc');
}

/**
 * Build the kernel-side `WireSegment[]` from a region's per-segment
 * geometry. Each `line` becomes a kernel line; each `arc` becomes a
 * three-point arc via the geometric midpoint of the swept angle.
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
    if (
      seg.kind === 'arc' &&
      seg.arcCenter !== undefined &&
      seg.arcRadius !== undefined &&
      seg.arcStartAngle !== undefined &&
      seg.arcEndAngle !== undefined
    ) {
      const [cx, cy] = seg.arcCenter;
      const r = seg.arcRadius;
      // Normalize sweep to the half-open interval (-π, π] and pick the
      // midpoint on the *minor* arc between start and end. The planar
      // graph computes `arcEndAngle - arcStartAngle` from the half-edge
      // endpoint atan2's, which can land either CW or CCW around the
      // circle depending on which face owns the arc — for inscribed
      // shapes (circle tangent to a rectangle), two of the four corner
      // regions get a (+3π/2) raw sweep but the actual boundary is the
      // (−π/2) minor arc. Forcing |sweep| ≤ π picks the minor arc every
      // time. Full circles aren't an issue here: the simple-circle
      // region in `detectSketchRegions` wins over the planar graph's
      // closed-loop face via the merge-priority fix, so we never see a
      // sweep ≈ ±2π in this branch.
      let sweep = seg.arcEndAngle - seg.arcStartAngle;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
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
      });
    } else {
      out.push({
        kind: 'line',
        start: sketchToWorld(seg.start, plane),
        end: sketchToWorld(seg.end, plane),
      });
    }
  }
  return out;
}
