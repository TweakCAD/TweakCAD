/**
 * Kernel types - internal types for geometry operations.
 * These never cross the worker boundary as-is.
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';

/** Opaque handle to a solid body in the kernel */
export type KernelBody = {
  handle: string;
  source: string;
};

/** Opaque handle to a face in the kernel */
export type KernelFace = {
  handle: string;
  bodyHandle: string;
};

/** Opaque handle to an edge in the kernel */
export type KernelEdge = {
  handle: string;
  bodyHandle: string;
};

/**
 * One segment of a `'wire'` profile. The kernel builds a real BREP edge
 * per segment so curves stay curves through extrude/revolve/loft. Uses a
 * polymorphic sketch-segment pattern — each segment kind maps to the
 * matching OCCT constructor (e.g. an arc to `GC_MakeArcOfCircle`). Backed
 * by `makeLineEdge` / `makeArcEdge` / `makeCircleEdge` on the kernel.
 *
 * Endpoint coordinates are already in 3D world space — the profile
 * resolver in the worker is responsible for mapping sketch-local 2D to
 * world via the sketch plane.
 */
export type WireSegment =
  | { kind: 'line'; start: Vec3; end: Vec3 }
  /**
   * Three-point arc through start → mid → end. `mid` is any point on
   * the arc between start and end (commonly the geometric midpoint
   * computed from the arc's center and the swept angle). Maps to
   * OCCT's `GC_MakeArcOfCircle_4` via occt-wasm's `makeArcEdge`.
   */
  | { kind: 'arc3pt'; start: Vec3; mid: Vec3; end: Vec3 }
  /**
   * Cubic Bézier edge through control points `[start, cp1, cp2, end]`.
   * Maps 1:1 to OCCT's `Geom_BezierCurve` via occt-wasm's
   * `makeBezierEdge` — the curve is exact (no polygonalization), so an
   * extruded Bézier boundary produces a single lateral face per curve.
   */
  | { kind: 'bezier'; start: Vec3; cp1: Vec3; cp2: Vec3; end: Vec3 }
  /**
   * Open interpolating B-spline edge through `points` (≥2, in order).
   * Backed by occt-wasm's `interpolatePoints(points, periodic=false)`
   * (OCCT `GeomAPI_Interpolate`). Used for a `spline` sketch curve on a
   * profile boundary: the worker samples the editor's Catmull-Rom curve
   * into `points` so the extruded edge follows the same shape the user
   * drew, and OCCT fits one smooth B-spline edge through them.
   */
  | { kind: 'spline'; points: Vec3[] };

/** Resolved 2D profile (closed wire) ready for extrusion.
 *
 * `'rectangle'` and `'slot'` profile kinds were retired in task F of
 * the sketch-commands-unification big-bang (invariant #11 — no
 * composite entities). Rectangles and slots arrive as their decomposed
 * lines + arcs and build via the general `'polygon'` / `'wire'` paths.
 */
export type ResolvedProfile = {
  type: 'circle' | 'polygon' | 'wire' | 'closedSpline';
  /**
   * Polygon corners (`'polygon'`), or — for `'closedSpline'` profiles —
   * the perimeter point ring (open, first point not repeated). A
   * `'closedSpline'` builds a single closed periodic B-spline face through
   * this ring via `interpolatePoints(…, periodic=true)`. It backs both
   * standalone ellipses (occt-wasm's `makeEllipseEdge` can't express an
   * in-plane-rotated ellipse) and standalone closed splines (e.g. an
   * imported DXF of self-closing curves).
   */
  vertices?: Vec3[];
  /**
   * For `'wire'` profiles: ordered closed-loop segments. Each segment
   * keeps its native curve type so OCCT extrudes/revolves a single
   * lateral face per *curve*, not per *sample point*. A rectangle with
   * one fillet should produce 4 lateral faces (3 lines + 1 arc), not
   * one per sampled facet.
   */
  segments?: WireSegment[];
  center?: Vec3;
  radius?: number;
  diameter?: number;
  width?: number;
  height?: number;
  normal: Vec3;
  origin: Vec3;
  /** Sketch plane U axis (width direction). If omitted, derived from normal. */
  uAxis?: Vec3;
  /** Sketch plane V axis (height direction). If omitted, derived from normal. */
  vAxis?: Vec3;
  /**
   * Inner profiles punched through this one as holes (even-odd nesting —
   * a washer is a circle/polygon outer with a circle hole). Each hole is a
   * full profile in its own right; the kernel builds its boundary wire the
   * same way and adds it via `addHolesInFace`. The worker decides nesting
   * (see `profileNesting.ts`); an empty/absent list is a plain face.
   */
  holes?: ResolvedProfile[];
};

/** Resolved plane in 3D space */
export type ResolvedPlane = {
  origin: Vec3;
  normal: Vec3;
  xDir: Vec3;
};

/** Resolved axis for patterns */
export type ResolvedAxis = {
  origin: Vec3;
  direction: Vec3;
};

/** Cylinder specification for kernel */
export type CylinderSpec = {
  center: Vec3;
  axis: Vec3;
  radius: number;
  height: number;
};

/**
 * Truncated cone (frustum) specification. Wraps OCCT's `BRepPrimAPI_MakeCone`:
 * `radius1` is at the cone's base (the z=0 end after orientation) and
 * `radius2` is at the top (z=height). Set `radius2 = 0` for a pointed
 * cone (used by the Hole builder's countersink mode). `center` is the
 * base end of the cone (analogous to `CylinderSpec.center`) and `axis`
 * is the direction the cone extends along.
 */
export type ConeSpec = {
  center: Vec3;
  axis: Vec3;
  radius1: number;
  radius2: number;
  height: number;
};

/**
 * Box. `origin` is the minimum corner, not the centre — the box grows in
 * +X/+Y/+Z from there. `width` is the X extent, `height` the Y extent and
 * `depth` the Z extent (pinned by a test in `primitives.test.ts`; every
 * other box in the suite is a cube, so a transposed mapping would not have
 * shown up until someone typed three different numbers).
 */
export type BoxSpec = {
  origin: Vec3;
  width: number;
  height: number;
  depth: number;
};

/**
 * Sphere. `center` is its centre, not a corner — unlike `BoxSpec.origin`,
 * because that is how a user thinks about a sphere and how OCCT's
 * `BRepPrimAPI_MakeSphere` is positioned.
 */
export type SphereSpec = {
  center: Vec3;
  radius: number;
};

/**
 * Torus. `majorRadius` is centre-to-tube-centre, `minorRadius` is the tube
 * itself, matching OCCT and every CAD convention.
 *
 * `axis` is the revolution axis — the normal of the ring's plane. A torus
 * with no axis would always lie flat in XY, which is rarely what you want.
 *
 * `minorRadius >= majorRadius` produces a self-intersecting solid that OCCT
 * will happily build and later booleans will choke on, so the builder rejects
 * it rather than letting it reach the kernel.
 */
export type TorusSpec = {
  center: Vec3;
  axis: Vec3;
  majorRadius: number;
  minorRadius: number;
};

/** Tessellation quality options */
export type TessellationOptions = {
  linearDeflection: number;
  angularDeflection: number;
};

/** STL export options */
export type StlExportOptions = {
  binary?: boolean;
  linearDeflection?: number;
  angularDeflection?: number;
};

/** STEP export options. Schema 5 = AP214 (most compatible). */
export type StepExportOptions = {
  /** STEP schema id: 3=AP203, 5=AP214 (default), 6=AP242. */
  schema?: number;
};

/** 3MF export options. Mesh-based — bodies are tessellated then packaged. */
export type ThreeMfExportOptions = {
  /** Display name written into the 3MF model XML. Default 'model'. */
  name?: string;
  /** Unit. Default 'millimeter' to match our document units. */
  unit?: 'micron' | 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
  linearDeflection?: number;
  angularDeflection?: number;
};

/** Structured kernel error */
export type KernelError = {
  category: 'geometry' | 'reference' | 'parameter' | 'kernel';
  code: string;
  message: string;
  suggestion?: string;
};

// --- Tessellation presets ---

/** Coarse tessellation: during dimension drag (fast) */
export const COARSE_TESSELLATION: TessellationOptions = {
  linearDeflection: 1.0,
  angularDeflection: 0.5,
};

/** Fine tessellation: after interaction settles (quality) */
export const FINE_TESSELLATION: TessellationOptions = {
  linearDeflection: 0.05,
  angularDeflection: 0.1,
};
