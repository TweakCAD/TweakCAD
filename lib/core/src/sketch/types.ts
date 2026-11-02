/**
 * Sketch entity types for the 2D sketch editor.
 *
 * Architecture: Point-based entity model where all geometry references
 * shared SketchPoint objects. This enables:
 * - Coincident points (shared between entities)
 * - Constraint solver integration (each point = solver variable)
 * - Drag-to-move behavior (move a point, all connected geometry updates)
 *
 * These types live in @tweakcad/core so both the web app sketch editor
 * and the worker buildSketch can import them.
 */
import type { Expression } from '../expressions.ts';


// ---- Identifiers ----

/** Unique identifier for a sketch point */
export type SketchPointId = string & { readonly __brand: 'SketchPointId' };

/** Unique identifier for a sketch geometry entity */
export type SketchGeometryId = string & { readonly __brand: 'SketchGeometryId' };

/** Unique identifier for a sketch constraint */
export type SketchConstraintId = string & { readonly __brand: 'SketchConstraintId' };

/** Deterministic identifier for a closed selectable sketch profile region */
export type SketchRegionId = string & { readonly __brand: 'SketchRegionId' };

export function sketchPointId(raw: string): SketchPointId {
  return raw as SketchPointId;
}

export function sketchGeometryId(raw: string): SketchGeometryId {
  return raw as SketchGeometryId;
}

export function sketchConstraintId(raw: string): SketchConstraintId {
  return raw as SketchConstraintId;
}

export function sketchRegionId(raw: string): SketchRegionId {
  return raw as SketchRegionId;
}

/**
 * V11.5 · Well-known ids for the sketch origin point + its anchoring
 * `fixed` constraint. Every sketch created via `CreateSketch` is seeded
 * with these so DOF accounting can ever reach 0 (otherwise the entire
 * sketch can translate in X+Y forever).
 *
 * The UI special-cases these:
 *   - The point renders with a distinct anchor glyph rather than the
 *     standard hover-able point sphere.
 *   - The Sketch Browser hides them from the geometry/constraint lists
 *     (or shows them as a single read-only "Origin" row, taste).
 *   - Store-side `removePoint` / `removeConstraint` reject deletion.
 *
 * The counter-id factory used in tests starts at `pt_1` / `con_1`, so
 * `pt_origin` / `con_origin_fixed` never collide with user geometry.
 */
export const ORIGIN_POINT_ID: SketchPointId = 'pt_origin' as SketchPointId;
export const ORIGIN_CONSTRAINT_ID: SketchConstraintId = 'con_origin_fixed' as SketchConstraintId;

// ---- Points ----

/** A point in 2D sketch space (mm). The fundamental building block. */
export type SketchPoint = {
  id: SketchPointId;
  x: number;
  y: number;
  /** Whether this point is locked in place (not moved by solver) */
  fixed: boolean;
};

// ---- Geometry ----

/** Union of all sketch geometry types.
 *
 * `SketchSlot` and `SketchPolygon` are not part of the union — every
 * tool that used to create them (drawSlot / drawPolygon) now emits their
 * decomposed primitives at draw time: a slot is 2 lines + 2 arcs
 * + constraints, a polygon is N lines + constraints.
 */
export type SketchGeometry =
  | SketchLineSegment
  | SketchCircle
  | SketchArc
  | SketchEllipse
  | SketchSpline
  | SketchBezier
  | SketchStandalonePoint;

/** Line segment between two points */
export type SketchLineSegment = {
  id: SketchGeometryId;
  type: 'line';
  /** Start point reference */
  startId: SketchPointId;
  /** End point reference */
  endId: SketchPointId;
  /** Construction geometry (dashed, not extrudable) */
  construction: boolean;
};

/** Circle defined by center point and radius */
export type SketchCircle = {
  id: SketchGeometryId;
  type: 'circle';
  /** Center point reference */
  centerId: SketchPointId;
  /** Radius in mm */
  radius: number;
  /** Construction geometry */
  construction: boolean;
};

/** Arc defined by center point, start/end points, and radius */
export type SketchArc = {
  id: SketchGeometryId;
  type: 'arc';
  /** Center point reference */
  centerId: SketchPointId;
  /** Start point reference (on the arc) */
  startId: SketchPointId;
  /** End point reference (on the arc) */
  endId: SketchPointId;
  /** Radius in mm */
  radius: number;
  /** Construction geometry */
  construction: boolean;
};

/** Ellipse defined by center, major axis end-point, and minor radius */
export type SketchEllipse = {
  id: SketchGeometryId;
  type: 'ellipse';
  /** Center point reference */
  centerId: SketchPointId;
  /** Point on the end of the major axis (defines rx and rotation) */
  majorId: SketchPointId;
  /** Minor-axis radius in mm */
  minorRadius: number;
  /** Construction geometry */
  construction: boolean;
};

// There are no composite `SketchSlot` (stadium shape) or `SketchPolygon`
// (regular N-gon) geometry types. The drawSlot / drawPolygon tools emit
// decomposed primitives at draw time (2 lines + 2 arcs for slot, N lines
// + center construction + constraints for polygon), so no editor-state
// geometry of these types is ever constructed. Invariant #11 ("no
// composite sketch entities") applies in the editor as well as the document.

/** Quadratic Bezier-ish spline as an ordered point sequence (low-fidelity). */
export type SketchSpline = {
  id: SketchGeometryId;
  type: 'spline';
  /** Ordered control point IDs (>=2) */
  pointIds: SketchPointId[];
  construction: boolean;
};

/**
 * Cubic Bezier curve: start + end are on-curve endpoints (constrainable, join
 * at coincident junctions); cp1 + cp2 are off-curve control poles. This is the
 * poles-based curve FreeCAD / Fusion / jsketcher all use, and SVG `C`/`Q`
 * commands map onto it 1:1 — unlike `SketchSpline`, which is a catmull-rom
 * curve that interpolates its points.
 */
export type SketchBezier = {
  id: SketchGeometryId;
  type: 'bezier';
  /** Start (on-curve) point reference */
  startId: SketchPointId;
  /** First control pole (off-curve) */
  cp1Id: SketchPointId;
  /** Second control pole (off-curve) */
  cp2Id: SketchPointId;
  /** End (on-curve) point reference */
  endId: SketchPointId;
  construction: boolean;
};

/** Standalone reference point (not part of any other geometry) */
export type SketchStandalonePoint = {
  id: SketchGeometryId;
  type: 'point';
  pointId: SketchPointId;
  construction: boolean;
};

// ---- Constraints ----

/** Union of all sketch constraint types */
export type SketchConstraint =
  | CoincidentConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | FixedConstraint
  | DistanceConstraint
  | DistanceXConstraint
  | DistanceYConstraint
  | RadiusConstraint
  | LengthConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | AngleConstraint
  | TangentConstraint
  | PointOnLineConstraint
  | PointOnCircleConstraint
  | SymmetricConstraint
  | EqualConstraint
  | ConcentricConstraint
  | MidpointConstraint;

/** Constraint input used by tools before the store assigns an id. */
export type SketchConstraintInput =
  | (Omit<CoincidentConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<HorizontalConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<VerticalConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<FixedConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<DistanceConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<DistanceXConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<DistanceYConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<RadiusConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<LengthConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<ParallelConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<PerpendicularConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<AngleConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<TangentConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<PointOnLineConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<PointOnCircleConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<SymmetricConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<EqualConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<ConcentricConstraint, 'id'> & { id?: SketchConstraintId })
  | (Omit<MidpointConstraint, 'id'> & { id?: SketchConstraintId });

/** Two points must be at the same location */
export type CoincidentConstraint = {
  id: SketchConstraintId;
  type: 'coincident';
  pointA: SketchPointId;
  pointB: SketchPointId;
};

/** A line segment must be horizontal (dy = 0) */
export type HorizontalConstraint = {
  id: SketchConstraintId;
  type: 'horizontal';
  geometryId: SketchGeometryId;
};

/** A line segment must be vertical (dx = 0) */
export type VerticalConstraint = {
  id: SketchConstraintId;
  type: 'vertical';
  geometryId: SketchGeometryId;
};

/** A point is fixed at its current position */
export type FixedConstraint = {
  id: SketchConstraintId;
  type: 'fixed';
  pointId: SketchPointId;
  x: number;
  y: number;
};

/**
 * V11 · Shared marker for "this dimension reports the current value but
 * doesn't constrain the geometry" (a driven dimension). Maps to
 * planegcs's per-constraint `driving: boolean` flag — when
 * `driven: true` we forward `driving: false` to the solver, which then
 * computes the parameter from current geometry rather than enforcing the
 * user's value.
 *
 * Common use: you've fully defined a shape via other constraints but
 * want to *see* the resulting length / radius / angle on the canvas
 * without over-constraining. The overlay paints these dimensions in
 * a muted colour so users can distinguish driving (enforced) from
 * driven (reported).
 *
 * Optional + default false so this is a strict addition — existing
 * dimensions stay driving.
 */
type DrivenFlag = { driven?: boolean };

/**
 * An optional parameter expression driving a dimension's value.
 *
 * This is where a parameter belongs. `buildGeometry` could carry an
 * `Expression` in a raw point coordinate, but that is the wrong place twice
 * over: no UI path can write one, and the solver is free to move a coordinate
 * afterwards, so a "parametric" position holds only until the next solve.
 * A dimension constraint is enforced — set the expression on the distance and
 * the solver puts the geometry where the parameter says.
 *
 * `value` stays, and stays authoritative for the editor. It is the last
 * solved number, so opening a sketch does not require resolving parameters
 * before anything can be drawn. When `expression` is present the build path
 * re-evaluates it against the project's parameters and solves, so `value`
 * is a cache that the next build refreshes.
 */
type ParametricValue = { expression?: Expression };

/** Distance between two points */
export type DistanceConstraint = {
  id: SketchConstraintId;
  type: 'distance';
  pointA: SketchPointId;
  pointB: SketchPointId;
  value: number;
} & DrivenFlag & ParametricValue;

/** Circle or arc radius must equal a value */
export type RadiusConstraint = {
  id: SketchConstraintId;
  type: 'radius';
  geometryId: SketchGeometryId;
  value: number;
} & DrivenFlag & ParametricValue;

/** Line segment length must equal a value */
export type LengthConstraint = {
  id: SketchConstraintId;
  type: 'length';
  geometryId: SketchGeometryId;
  value: number;
} & DrivenFlag & ParametricValue;

/** Two line segments must be parallel */
export type ParallelConstraint = {
  id: SketchConstraintId;
  type: 'parallel';
  geometryA: SketchGeometryId;
  geometryB: SketchGeometryId;
};

/** Two line segments must be perpendicular */
export type PerpendicularConstraint = {
  id: SketchConstraintId;
  type: 'perpendicular';
  geometryA: SketchGeometryId;
  geometryB: SketchGeometryId;
};

/**
 * Angle between two line segments. `value` is the target angle in **radians**,
 * measured CCW from line A's direction (start→end) to line B's direction
 * (start→end). Residual = (current_angle − value), so the solver drives
 * line B to sit at exactly `value` radians from line A.
 *
 * `expression`, when set, is in **degrees** like every other angle a user
 * writes; the build path converts it to radians before solving
 * (`resolveSketchDimensions`).
 */
export type AngleConstraint = {
  id: SketchConstraintId;
  type: 'angle';
  geometryA: SketchGeometryId;
  geometryB: SketchGeometryId;
  /** Target angle in radians (CCW positive from A to B). */
  value: number;
} & DrivenFlag & ParametricValue;

/**
 * Two curves must touch at exactly one point.
 *
 * Two flavours selected by which fields are populated:
 *
 *   - **Line ↔ circle/arc.** `lineId` + `circleId` set, `secondCircleId`
 *     undefined. Residual = perpendicular-distance from the circle's
 *     center to the (infinite) line, minus the radius. There is no
 *     "internal" variant for line-circle (a straight line either touches
 *     the disk boundary or not — no inside/outside distinction). The
 *     `internal` field is ignored in this case.
 *
 *   - **Circle ↔ circle.** `circleId` + `secondCircleId` set, `lineId`
 *     undefined. Two variants selected by `internal`:
 *       - `internal: false` (default) → external tangent. Residual
 *         |centerA − centerB| − (rA + rB) = 0. Circles touch from outside.
 *       - `internal: true` → internal tangent. Residual
 *         |centerA − centerB| − |rA − rB| = 0. One circle sits *inside*
 *         the other, touching from the inside (bearing-in-bore, planet
 *         gear in ring gear, etc.). The UI ribbon auto-detects which
 *         variant the user wants from the current circle positions
 *         (`sketchConstraints.ts`).
 *
 * Both `circleId` and (when populated) `secondCircleId` may reference
 * `'circle'` or `'arc'` geometry — we read the centerId + radius the
 * same way for both.
 *
 * **Solver coverage.** planegcs (the default) supports both external and
 * internal natively via its `tangent_circumf` primitive
 * (`internal: boolean` flag). planegcs (the only solver) implements
 * both external and internal tangency.
 */
export type TangentConstraint = {
  id: SketchConstraintId;
  type: 'tangent';
  /** Set for line-circle tangent. Must reference a `'line'` geometry. */
  lineId?: SketchGeometryId;
  /** First circle/arc. Always required. */
  circleId: SketchGeometryId;
  /** Set for circle-circle tangent. Must reference a `'circle'` or `'arc'` geometry. */
  secondCircleId?: SketchGeometryId;
  /**
   * Circle-circle only. When true, the two circles touch from inside
   * (one nested in the other). Ignored for the line-circle case.
   * Defaults to false (external tangent).
   */
  internal?: boolean;
};

/**
 * Signed horizontal distance between two points: residual = (pB.x − pA.x) − value.
 * Value is signed so the constraint preserves orientation; UI displays |value|.
 */
export type DistanceXConstraint = {
  id: SketchConstraintId;
  type: 'distanceX';
  pointA: SketchPointId;
  pointB: SketchPointId;
  /** Signed (pB.x − pA.x) target in mm. */
  value: number;
} & DrivenFlag & ParametricValue;

/** Signed vertical distance — see {@link DistanceXConstraint}. */
export type DistanceYConstraint = {
  id: SketchConstraintId;
  type: 'distanceY';
  pointA: SketchPointId;
  pointB: SketchPointId;
  /** Signed (pB.y − pA.y) target in mm. */
  value: number;
} & DrivenFlag & ParametricValue;

/**
 * A point must lie on a line segment's infinite extension.
 * Residual = cross(lineDir, point − lineStart).
 */
export type PointOnLineConstraint = {
  id: SketchConstraintId;
  type: 'pointOnLine';
  pointId: SketchPointId;
  /** Must reference a `'line'` geometry. */
  geometryId: SketchGeometryId;
};

/**
 * A point must lie on a circle (distance from center == radius).
 * Residual = |point − center| − radius.
 * `geometryId` may reference a `'circle'` or `'arc'` (uses its centerId + radius).
 */
export type PointOnCircleConstraint = {
  id: SketchConstraintId;
  type: 'pointOnCircle';
  pointId: SketchPointId;
  geometryId: SketchGeometryId;
};

/**
 * Two points are symmetric about a line.
 * Two residuals: midpoint(pA,pB) is on the line AND (pB−pA) is perpendicular
 * to the line direction.
 */
export type SymmetricConstraint = {
  id: SketchConstraintId;
  type: 'symmetric';
  pointA: SketchPointId;
  pointB: SketchPointId;
  /** Must reference a `'line'` geometry — the symmetry axis. */
  geometryId: SketchGeometryId;
};

/**
 * Two same-kind geometries must be equal.
 *   - Two lines: |A.start−A.end| = |B.start−B.end| (equal length).
 *   - Two circles, two arcs, or one of each: A.radius = B.radius.
 *
 * Replaces the older "pin to current length/radius" hack — that pinned a
 * value snapshot which silently broke when the reference geometry was
 * later resized. This is a relational constraint: change one, the other
 * follows via the solver. The planegcs adapter emits `equal_length`,
 * `equal_radius_cc`, `equal_radius_ca`, or `equal_radius_aa` depending on
 * the geometry pair.
 */
export type EqualConstraint = {
  id: SketchConstraintId;
  type: 'equal';
  geometryA: SketchGeometryId;
  geometryB: SketchGeometryId;
};

/**
 * Two circles/arcs share a centre point. Residual = |centerA − centerB|.
 * Implemented in the planegcs adapter as a single `p2p_coincident` on the
 * two geometries' centre points — planegcs has no dedicated "concentric"
 * primitive, but our point-graph already represents centres as shared
 * `SketchPointId`s, so coincident is the natural fit.
 */
export type ConcentricConstraint = {
  id: SketchConstraintId;
  type: 'concentric';
  /** First circle or arc. */
  geometryA: SketchGeometryId;
  /** Second circle or arc. */
  geometryB: SketchGeometryId;
};

/**
 * A point must lie at the midpoint of a line segment.
 *
 * Residual = |P − (A+B)/2| where A,B are the line endpoints. Maps to
 * planegcs's `p2p_symmetric_ppp(A, B, P)` — "A and B are symmetric
 * about P" — which is the same statement as "P is the midpoint of
 * AB" without needing a helper construction.
 *
 * Arc-midpoint (point at the midpoint of an arc) would need a
 * separate constraint kind because the midpoint isn't a simple
 * average — defer until a workflow actually needs it.
 */
export type MidpointConstraint = {
  id: SketchConstraintId;
  type: 'midpoint';
  pointId: SketchPointId;
  /** Must reference a `'line'` geometry. */
  geometryId: SketchGeometryId;
};

// ---- Geometry Input (for addGeometry - id is optional, auto-generated) ----

export type SketchGeometryInput =
  | (Omit<SketchLineSegment, 'id'> & { id?: SketchGeometryId })
  | (Omit<SketchCircle, 'id'> & { id?: SketchGeometryId })
  | (Omit<SketchArc, 'id'> & { id?: SketchGeometryId })
  | (Omit<SketchEllipse, 'id'> & { id?: SketchGeometryId })
  | (Omit<SketchSpline, 'id'> & { id?: SketchGeometryId })
  | (Omit<SketchBezier, 'id'> & { id?: SketchGeometryId })
  | (Omit<SketchStandalonePoint, 'id'> & { id?: SketchGeometryId });

// ---- Tool Types ----

export type SketchToolId =
  | 'select'
  | 'line'
  | 'rectangle'
  | 'circle'
  // V10 · Two extra circle constructors.
  // `circle-2point` interprets the two clicks as ends of a diameter
  // (centre = midpoint, radius = half-distance). `circle-3point` solves
  // the circumcircle through three picked points via
  // `circleFrom3Points`. Both emit a normal `SketchDrawCircle` command —
  // no new schema entity, no special-case render path — so picking,
  // serialization, region detection all keep working unchanged.
  | 'circle-2point'
  | 'circle-3point'
  | 'arc-3point'
  | 'arc-center'
  | 'polygon'
  | 'slot'
  | 'ellipse'
  | 'spline'
  // Text: places a line of text as glyph-outline lines + beziers (no text
  // entity — see sketch/text/textOutline.ts).
  | 'text'
  | 'point'
  | 'trim'
  | 'extend'
  | 'sketch-fillet'
  | 'offset'
  | 'sketch-mirror'
  | 'dimension'
  | 'dimension-x'
  | 'dimension-y'
  | null;

// ---- Preview Data (rubber-band during drawing) ----

export type SketchPreviewData =
  | { type: 'line'; startX: number; startY: number; endX: number; endY: number }
  | { type: 'rectangle'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'circle'; centerX: number; centerY: number; radius: number }
  | { type: 'arc'; centerX: number; centerY: number; radius: number; startAngle: number; endAngle: number }
  | { type: 'polygon'; centerX: number; centerY: number; vertexX: number; vertexY: number; sides: number }
  | { type: 'slot'; x1: number; y1: number; x2: number; y2: number; width: number }
  | { type: 'ellipse'; centerX: number; centerY: number; majorX: number; majorY: number; minorRadius: number }
  | { type: 'spline'; points: [number, number][]; cursorX: number; cursorY: number }
  // Text tool: the sampled glyph outlines, already placed at the cursor.
  | { type: 'outline'; loops: [number, number][][] }
  | null;

// ---- Hit Test ----

export type HitTarget =
  | { type: 'point'; id: SketchPointId }
  | { type: 'geometry'; id: SketchGeometryId }
  | { type: 'region'; id: SketchRegionId }
  | null;

// ---- Snap ----

export type SnapResult = {
  x: number;
  y: number;
  type: 'grid' | 'point' | 'midpoint' | 'intersection' | 'none';
  /** The point/entity id if snapping to an entity */
  targetId?: string;
  /** Geometry id when snapping to derived geometry such as a midpoint */
  geometryId?: SketchGeometryId;
};
