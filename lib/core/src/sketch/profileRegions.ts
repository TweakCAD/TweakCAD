/**
 * Sketch profile region detection and resolution.
 *
 * This module extracts closed, extrudable regions from sketch entities. It is
 * intentionally pure and JSON-friendly so both the web UI and worker rebuild
 * path can use the same region ids and vertices.
 *
 * It also provides profile resolution: matching a stored ProfileRef against
 * currently detected regions using entity-ID set equality (with interior-point
 * fallback for disambiguation).
 */

import type { SketchEntity, ProfileRef } from '../document/schema.ts';
import type { EntityId, FeatureId } from '../ids.ts';
import { detectIntersectionRegions } from './planarGraph.ts';
import type { PlanarFace } from './planarGraph.ts';
import { catmullRomSpline, catmullRomClosed, sampleEllipse } from './curveSampling.ts';

/**
 * One segment of a region boundary. The optional `kind` + geometry
 * fields preserve the native curve type from the planar graph so the
 * downstream kernel pipeline can build real BREP arc edges (not 64
 * polygonalized facets) for arc/fillet/circle segments.
 *
 * When `kind` is missing, the consumer treats the segment as a straight
 * line from the region's sampled vertex `i` to vertex `i + 1` — matches
 * the pre-arc behavior of the polygon fast path.
 */
export type SketchRegionSegment = {
  entityId: EntityId;
  reversed: boolean;
  /** Native curve type. `undefined` falls back to line (legacy). */
  kind?: 'line' | 'arc' | 'bezier' | 'spline';
  /**
   * Start point in sketch-local 2D coords. Required when `kind` is set.
   * For curve-loop segments the start/end are already oriented in loop
   * traversal order (a segment walked backwards has its endpoints — and
   * its arc angles / Bézier poles — pre-swapped), so the kernel consumer
   * can read them directly without re-applying `reversed`.
   */
  start?: [number, number];
  /** End point in sketch-local 2D coords. Required when `kind` is set. */
  end?: [number, number];
  /** Arc-only: center in sketch-local coords. */
  arcCenter?: [number, number];
  /** Arc-only: radius in mm. */
  arcRadius?: number;
  /** Arc-only: start angle in radians (atan2 of start vs center). */
  arcStartAngle?: number;
  /** Arc-only: end angle in radians. CCW from start. */
  arcEndAngle?: number;
  /** Bézier-only: first off-curve control pole (after `start`). */
  bezierCp1?: [number, number];
  /** Bézier-only: second off-curve control pole (before `end`). */
  bezierCp2?: [number, number];
  /**
   * Spline-only: ordered Catmull-Rom control points, oriented in loop
   * traversal order (`start` == first, `end` == last). The worker samples
   * the curve through these for the kernel B-spline fit.
   */
  splinePoints?: [number, number][];
};

export type SketchRegion = {
  id: string;
  label: string;
  type: 'circle' | 'polygon' | 'ellipse' | 'closedSpline';
  entityIds: EntityId[];
  /**
   * Every entity on this region's own boundary (the outer loop). Hole
   * boundaries are not included — see {@link regionWireEntityIds} for the
   * outer + direct-hole set.
   */
  allEntityIds: EntityId[];
  segments: SketchRegionSegment[];
  vertices: [number, number][];
  center: [number, number];
  area: number;
  /** Ellipse-only: absolute major-axis endpoint (encodes radius + rotation). */
  ellipseMajorEnd?: [number, number];
  /** Ellipse-only: minor radius (mm). */
  ellipseMinorRadius?: number;
  /**
   * Closed-spline-only: the spline's control points (the closing
   * duplicate, if any, removed), in sketch-local 2D. The kernel fits a
   * periodic B-spline through these.
   */
  splineControlPoints?: [number, number][];
  /**
   * Regions directly nested inside this one — they punch holes through
   * it. A circle drawn inside a square makes the square's region an
   * annulus (`holes: [circleRegion]`) while the circle is still its own
   * separate region. Assigned by `assignHoles` after detection. Selection
   * and the extrude face both subtract these. One level only (a hole's own
   * holes live on the hole region), which is enough because each region
   * holds just its *direct* children.
   */
  holes?: SketchRegion[];
};

// --- Profile Resolution Types ---

export type ResolvedProfileResult = {
  profileRef: ProfileRef;
  status: 'resolved' | 'missing';
  region?: SketchRegion;
  error?: string;
};

const POINT_KEY_PRECISION = 6;
const EPSILON = 1e-6;

function expressionToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pointKey(point: [number, number]): string {
  return `${point[0].toFixed(POINT_KEY_PRECISION)},${point[1].toFixed(POINT_KEY_PRECISION)}`;
}

function distance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function polygonArea(vertices: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const current = vertices[i]!;
    const next = vertices[(i + 1) % vertices.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function polygonCenter(vertices: [number, number][]): [number, number] {
  const signedArea = polygonArea(vertices);
  if (Math.abs(signedArea) <= EPSILON) {
    const total = vertices.reduce<[number, number]>(
      (sum, vertex) => [sum[0] + vertex[0], sum[1] + vertex[1]],
      [0, 0],
    );
    return [total[0] / vertices.length, total[1] / vertices.length];
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < vertices.length; i++) {
    const current = vertices[i]!;
    const next = vertices[(i + 1) % vertices.length]!;
    const cross = current[0] * next[1] - next[0] * current[1];
    cx += (current[0] + next[0]) * cross;
    cy += (current[1] + next[1]) * cross;
  }

  const factor = 1 / (6 * signedArea);
  return [cx * factor, cy * factor];
}

function canonicalRegionId(entityIds: EntityId[]): string {
  return `region:${entityIds.map(id => String(id)).sort().join('|')}`;
}

function normalizeVertices(vertices: [number, number][]): [number, number][] {
  if (vertices.length === 0) return vertices;

  let startIndex = 0;
  for (let i = 1; i < vertices.length; i++) {
    const current = pointKey(vertices[i]!);
    const best = pointKey(vertices[startIndex]!);
    if (current < best) startIndex = i;
  }

  return vertices.map((_, offset) => vertices[(startIndex + offset) % vertices.length]!);
}

function normalizeSegments(segments: SketchRegionSegment[]): SketchRegionSegment[] {
  if (segments.length === 0) return segments;

  let startIndex = 0;
  for (let i = 1; i < segments.length; i++) {
    if (String(segments[i]!.entityId) < String(segments[startIndex]!.entityId)) startIndex = i;
  }

  return segments.map((_, offset) => segments[(startIndex + offset) % segments.length]!);
}

/**
 * One open boundary edge — a `line`, `arc`, cubic `bezier`, or `spline`
 * entity reduced to its two endpoints plus the analytic data the kernel
 * needs to rebuild the curve. Closed entities (circle, full ellipse) are
 * NOT edges; they're standalone single-entity regions.
 *
 * `start`/`end` (and, for an arc, its angles; for a Bézier, its poles;
 * for a spline, its control points) are always given in this edge's
 * natural orientation. The loop walker pre-orients each edge into
 * traversal order via {@link reverseCurveEdge} before emitting a region
 * segment, so no `reversed` flag is needed downstream.
 */
type CurveEdge = {
  entity: SketchEntity;
  kind: 'line' | 'arc' | 'bezier' | 'spline';
  start: [number, number];
  end: [number, number];
  arcCenter?: [number, number];
  arcRadius?: number;
  arcStartAngle?: number;
  arcEndAngle?: number;
  bezierCp1?: [number, number];
  bezierCp2?: [number, number];
  splinePoints?: [number, number][];
};

/** Number of straight facets used to sample a curve's *vertices* (for
 *  area / centroid / point-in-region only — the kernel still receives the
 *  analytic curve as a single BREP edge, so this never reaches geometry). */
const CURVE_VERTEX_SAMPLES = 8;

/** Perimeter samples for a standalone ellipse region's vertices/centroid.
 *  Independent of the kernel's perimeter fit — see `detectEllipseRegions`. */
const ELLIPSE_VERTEX_SAMPLES = 32;

/** Catmull-Rom samples per span for a closed-spline region's outline
 *  (fill / hit-test / area) — see `detectClosedSplineRegions`. */
const CLOSED_SPLINE_OUTLINE_SAMPLES = 8;

function cubicBezierPoint(
  p0: [number, number], c1: [number, number],
  c2: [number, number], p3: [number, number], t: number,
): [number, number] {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
  ];
}

/** Reduce an entity to a {@link CurveEdge} in natural orientation, or
 *  `null` if it isn't an open boundary edge (construction, closed, or
 *  unresolvable). */
function getCurveEdge(entity: SketchEntity): CurveEdge | null {
  if (entity.construction) return null;

  if (entity.type === 'line') {
    const sx = expressionToNumber(entity.start[0]);
    const sy = expressionToNumber(entity.start[1]);
    const ex = expressionToNumber(entity.end[0]);
    const ey = expressionToNumber(entity.end[1]);
    if (sx === null || sy === null || ex === null || ey === null) return null;
    const start: [number, number] = [sx, sy];
    const end: [number, number] = [ex, ey];
    if (distance(start, end) <= EPSILON) return null;
    return { entity, kind: 'line', start, end };
  }

  if (entity.type === 'arc') {
    const cx = expressionToNumber(entity.center[0]);
    const cy = expressionToNumber(entity.center[1]);
    const r = expressionToNumber(entity.radius);
    const sa = expressionToNumber(entity.startAngle);
    const ea = expressionToNumber(entity.endAngle);
    if (cx === null || cy === null || r === null || sa === null || ea === null) return null;
    if (r <= EPSILON) return null;
    const start: [number, number] = [cx + r * Math.cos(sa), cy + r * Math.sin(sa)];
    const end: [number, number] = [cx + r * Math.cos(ea), cy + r * Math.sin(ea)];
    // A full-circle arc (start ≈ end) can't be an endpoint-connected loop
    // member; standalone closed arcs aren't supported here.
    if (distance(start, end) <= EPSILON) return null;
    return {
      entity, kind: 'arc', start, end,
      arcCenter: [cx, cy], arcRadius: r, arcStartAngle: sa, arcEndAngle: ea,
    };
  }

  if (entity.type === 'bezier') {
    const sx = expressionToNumber(entity.start[0]);
    const sy = expressionToNumber(entity.start[1]);
    const c1x = expressionToNumber(entity.cp1[0]);
    const c1y = expressionToNumber(entity.cp1[1]);
    const c2x = expressionToNumber(entity.cp2[0]);
    const c2y = expressionToNumber(entity.cp2[1]);
    const ex = expressionToNumber(entity.end[0]);
    const ey = expressionToNumber(entity.end[1]);
    if (
      sx === null || sy === null || c1x === null || c1y === null ||
      c2x === null || c2y === null || ex === null || ey === null
    ) return null;
    const start: [number, number] = [sx, sy];
    const end: [number, number] = [ex, ey];
    if (distance(start, end) <= EPSILON) return null;
    return {
      entity, kind: 'bezier', start, end,
      bezierCp1: [c1x, c1y], bezierCp2: [c2x, c2y],
    };
  }

  if (entity.type === 'spline') {
    const pts: [number, number][] = [];
    for (const p of entity.points) {
      const px = expressionToNumber(p[0]);
      const py = expressionToNumber(p[1]);
      if (px === null || py === null) return null;
      pts.push([px, py]);
    }
    // Need ≥2 control points and distinct endpoints to be an open edge.
    if (pts.length < 2) return null;
    const start = pts[0]!;
    const end = pts[pts.length - 1]!;
    if (distance(start, end) <= EPSILON) return null;
    return { entity, kind: 'spline', start, end, splinePoints: pts };
  }

  return null;
}

/** Flip an edge end-for-end, swapping the orientation-dependent analytic
 *  data (arc angles, Bézier poles) so the reversed edge still describes
 *  the same physical curve. */
function reverseCurveEdge(e: CurveEdge): CurveEdge {
  // Analytic fields are guaranteed present for their kind (set in
  // `getCurveEdge`); the `!` asserts that against the optional typing.
  if (e.kind === 'arc') {
    return {
      entity: e.entity, kind: 'arc', start: e.end, end: e.start,
      arcCenter: e.arcCenter!, arcRadius: e.arcRadius!,
      arcStartAngle: e.arcEndAngle!, arcEndAngle: e.arcStartAngle!,
    };
  }
  if (e.kind === 'bezier') {
    return {
      entity: e.entity, kind: 'bezier', start: e.end, end: e.start,
      bezierCp1: e.bezierCp2!, bezierCp2: e.bezierCp1!,
    };
  }
  if (e.kind === 'spline') {
    return {
      entity: e.entity, kind: 'spline', start: e.end, end: e.start,
      splinePoints: [...e.splinePoints!].reverse(),
    };
  }
  return { entity: e.entity, kind: 'line', start: e.end, end: e.start };
}

function edgeToSegment(e: CurveEdge): SketchRegionSegment {
  const seg: SketchRegionSegment = {
    entityId: e.entity.id,
    reversed: false,
    kind: e.kind,
    start: e.start,
    end: e.end,
  };
  if (e.kind === 'arc') {
    seg.arcCenter = e.arcCenter!;
    seg.arcRadius = e.arcRadius!;
    seg.arcStartAngle = e.arcStartAngle!;
    seg.arcEndAngle = e.arcEndAngle!;
  } else if (e.kind === 'bezier') {
    seg.bezierCp1 = e.bezierCp1!;
    seg.bezierCp2 = e.bezierCp2!;
  } else if (e.kind === 'spline') {
    seg.splinePoints = e.splinePoints!;
  }
  return seg;
}

/** Sample an oriented edge's vertices from `start` (inclusive) up to but
 *  not including `end` — concatenated around a loop these form the
 *  region polygon used for area / centroid / containment tests. */
function sampleEdgeVertices(e: CurveEdge): [number, number][] {
  if (e.kind === 'line') return [e.start];
  if (e.kind === 'arc') {
    const [cx, cy] = e.arcCenter!;
    const r = e.arcRadius!;
    const sweep = e.arcEndAngle! - e.arcStartAngle!;
    const pts: [number, number][] = [];
    for (let i = 0; i < CURVE_VERTEX_SAMPLES; i++) {
      const a = e.arcStartAngle! + (sweep * i) / CURVE_VERTEX_SAMPLES;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }
  if (e.kind === 'spline') {
    // Sample the Catmull-Rom curve through the control points, then drop
    // the final point so concatenation around the loop doesn't duplicate
    // the shared junction (matches the line/arc/bezier convention).
    const sampled = catmullRomSpline(e.splinePoints!, 4);
    return sampled.length > 1 ? sampled.slice(0, -1) : sampled;
  }
  // bezier
  const pts: [number, number][] = [];
  for (let i = 0; i < CURVE_VERTEX_SAMPLES; i++) {
    pts.push(cubicBezierPoint(e.start, e.bezierCp1!, e.bezierCp2!, e.end, i / CURVE_VERTEX_SAMPLES));
  }
  return pts;
}

/** Build a region from an oriented head-to-tail loop of curve edges. A
 *  pure-line loop needs ≥3 edges (a triangle); a loop containing at least
 *  one curve can close with just 2 edges (e.g. a "D": one line + one arc). */
function makeCurveLoopRegion(orientedEdges: CurveEdge[]): SketchRegion | null {
  const segments = orientedEdges.map(edgeToSegment);
  const uniqueEntityIds = [...new Set(segments.map(s => s.entityId))];
  const hasCurve = orientedEdges.some(e => e.kind !== 'line');
  if (uniqueEntityIds.length < (hasCurve ? 2 : 3)) return null;

  const sampled: [number, number][] = [];
  for (const e of orientedEdges) sampled.push(...sampleEdgeVertices(e));
  if (sampled.length < 3) return null;

  let normalizedVertices = normalizeVertices(sampled);
  const signedArea = polygonArea(normalizedVertices);
  if (Math.abs(signedArea) <= EPSILON) return null;
  if (signedArea < 0) {
    normalizedVertices = [normalizedVertices[0]!, ...normalizedVertices.slice(1).reverse()];
  }

  return {
    id: canonicalRegionId(uniqueEntityIds),
    label: `Profile ${uniqueEntityIds.length} edges`,
    type: 'polygon',
    entityIds: uniqueEntityIds,
    allEntityIds: uniqueEntityIds,
    segments: normalizeSegments(segments),
    vertices: normalizedVertices,
    center: polygonCenter(normalizedVertices),
    area: Math.abs(signedArea),
  };
}

/**
 * Walk endpoint-connected `line` / `arc` / `bezier` edges into closed
 * boundary loops. Supersedes the old line-only walker — pure-line loops
 * behave identically (each line becomes a `kind: 'line'` segment), and
 * curve edges carry their analytic data through so the kernel builds one
 * real BREP edge per curve (no polygonalization on this side).
 *
 * Intersecting curves are out of scope here (the planar-graph detector
 * still only subdivides line/circle); this walker targets the common
 * imported-outline case where segments meet at shared endpoints.
 */
function detectCurveLoopRegions(entities: Record<EntityId, SketchEntity>): SketchRegion[] {
  const edges = Object.values(entities)
    .map(getCurveEdge)
    .filter((e): e is CurveEdge => e !== null);

  const regions: SketchRegion[] = [];
  const seen = new Set<string>();

  for (const seed of edges) {
    const visited = new Set<EntityId>([seed.entity.id]);
    const oriented: CurveEdge[] = [seed];

    const walk = (current: [number, number]): void => {
      if (visited.size > edges.length) return;

      for (const candidate of edges) {
        if (visited.has(candidate.entity.id)) continue;

        const connectsToStart = pointKey(candidate.start) === pointKey(current);
        const connectsToEnd = pointKey(candidate.end) === pointKey(current);
        if (!connectsToStart && !connectsToEnd) continue;

        const orientedEdge = connectsToStart ? candidate : reverseCurveEdge(candidate);
        const next = orientedEdge.end;
        visited.add(candidate.entity.id);
        oriented.push(orientedEdge);

        if (pointKey(next) === pointKey(seed.start)) {
          const region = makeCurveLoopRegion([...oriented]);
          if (region && !seen.has(region.id)) {
            seen.add(region.id);
            regions.push(region);
          }
        } else {
          walk(next);
        }

        oriented.pop();
        visited.delete(candidate.entity.id);
      }
    };

    walk(seed.end);
  }

  return regions.sort((a, b) => b.area - a.area || a.id.localeCompare(b.id));
}

function detectCircleRegions(entities: Record<EntityId, SketchEntity>): SketchRegion[] {
  const regions: SketchRegion[] = [];

  for (const entity of Object.values(entities)) {
    if (entity.type !== 'circle' || entity.construction) continue;
    const cx = expressionToNumber(entity.center[0]);
    const cy = expressionToNumber(entity.center[1]);
    const diameter = expressionToNumber(entity.diameter);
    if (cx === null || cy === null || diameter === null || diameter <= EPSILON) continue;
    const radius = diameter / 2;
    regions.push({
      id: `region:${String(entity.id)}`,
      label: 'Profile circle',
      type: 'circle',
      entityIds: [entity.id],
      allEntityIds: [entity.id],
      segments: [{ entityId: entity.id, reversed: false }],
      vertices: [],
      center: [cx, cy],
      area: Math.PI * radius * radius,
    });
  }

  return regions;
}

/**
 * A full ellipse is a closed curve, so — like a circle — it's its own
 * standalone single-entity region. The region carries the ellipse params
 * (center + major-axis endpoint + minor radius); the kernel samples the
 * perimeter and fits one periodic B-spline face (occt-wasm's ellipse-edge
 * builder can't represent a rotated ellipse). Sampled `vertices` are
 * stored for area / centroid / point-in-region tests.
 */
function detectEllipseRegions(entities: Record<EntityId, SketchEntity>): SketchRegion[] {
  const regions: SketchRegion[] = [];

  for (const entity of Object.values(entities)) {
    if (entity.type !== 'ellipse' || entity.construction) continue;
    const cx = expressionToNumber(entity.center[0]);
    const cy = expressionToNumber(entity.center[1]);
    const mx = expressionToNumber(entity.majorEnd[0]);
    const my = expressionToNumber(entity.majorEnd[1]);
    const minorRadius = expressionToNumber(entity.minorRadius);
    if (cx === null || cy === null || mx === null || my === null || minorRadius === null) continue;
    const majorRadius = Math.hypot(mx - cx, my - cy);
    if (majorRadius <= EPSILON || minorRadius <= EPSILON) continue;

    const center: [number, number] = [cx, cy];
    regions.push({
      id: `region:${String(entity.id)}`,
      label: 'Profile ellipse',
      type: 'ellipse',
      entityIds: [entity.id],
      allEntityIds: [entity.id],
      segments: [{ entityId: entity.id, reversed: false }],
      vertices: sampleEllipse(center, [mx, my], minorRadius, ELLIPSE_VERTEX_SAMPLES),
      center,
      area: Math.PI * majorRadius * minorRadius,
      ellipseMajorEnd: [mx, my],
      ellipseMinorRadius: minorRadius,
    });
  }

  return regions;
}

/**
 * A *self-closed* spline (first control point ≈ last) is a closed curve,
 * so — like a circle or ellipse — it's its own standalone region. Common
 * in imported art (e.g. a DXF of closed organic shapes). The kernel fits
 * one periodic B-spline face through the control points.
 *
 * Open splines are NOT handled here; they're loop-boundary edges picked
 * up by `detectCurveLoopRegions` (via `getCurveEdge`).
 */
function detectClosedSplineRegions(entities: Record<EntityId, SketchEntity>): SketchRegion[] {
  const regions: SketchRegion[] = [];

  for (const entity of Object.values(entities)) {
    if (entity.type !== 'spline' || entity.construction) continue;
    const pts: [number, number][] = [];
    let bad = false;
    for (const p of entity.points) {
      const px = expressionToNumber(p[0]);
      const py = expressionToNumber(p[1]);
      if (px === null || py === null) { bad = true; break; }
      pts.push([px, py]);
    }
    if (bad || pts.length < 3) continue;

    // Closed iff first ≈ last. Drop the duplicate closing point so the
    // periodic fit doesn't see a doubled vertex.
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (distance(first, last) > EPSILON) continue; // open spline → handled as an edge
    const ring = pts.slice(0, -1);
    if (ring.length < 3) continue;

    // Outline = the smooth *periodic* Catmull-Rom (the same curve the
    // kernel extrudes and the editor now renders), so the region fill,
    // hit-test, and area follow the actual curve rather than the angular
    // control polygon. `splineControlPoints` keeps the raw ring for the
    // kernel fit.
    const outline = catmullRomClosed(ring, CLOSED_SPLINE_OUTLINE_SAMPLES);

    regions.push({
      id: `region:${String(entity.id)}`,
      label: 'Profile closed spline',
      type: 'closedSpline',
      entityIds: [entity.id],
      allEntityIds: [entity.id],
      segments: [{ entityId: entity.id, reversed: false }],
      vertices: outline,
      center: polygonCenter(outline),
      area: Math.abs(polygonArea(outline)),
      splineControlPoints: ring,
    });
  }

  return regions;
}

/**
 * Convert a PlanarFace (from the planar graph detector) into a SketchRegion.
 *
 * Per-segment geometry (start / end / arcCenter / arcRadius / etc.) is
 * preserved here so the downstream kernel pipeline can rebuild real BREP
 * arc edges instead of polygonalizing every curved boundary into 64
 * straight facets. See `WireSegment` in `@tweakcad/kernel/src/types.ts`
 * for the kernel-side consumer.
 */
function planarFaceToRegion(face: PlanarFace, index: number): SketchRegion {
  const entityIds = face.entityIds as EntityId[];
  return {
    id: `pgraph:${index}:${entityIds.map(String).sort().join('|')}`,
    label: `Profile (${entityIds.length} entities)`,
    type: 'polygon',
    entityIds,
    allEntityIds: entityIds,
    segments: face.edges.map((e): SketchRegionSegment => {
      const base: SketchRegionSegment = {
        entityId: e.entityId as EntityId,
        reversed: false,
        kind: e.curveType,
        start: [e.start[0], e.start[1]],
        end: [e.end[0], e.end[1]],
      };
      if (e.curveType === 'arc' && e.center !== undefined && e.radius !== undefined) {
        base.arcCenter = [e.center[0], e.center[1]];
        base.arcRadius = e.radius;
        if (e.startAngle !== undefined) base.arcStartAngle = e.startAngle;
        if (e.endAngle !== undefined) base.arcEndAngle = e.endAngle;
      }
      return base;
    }),
    vertices: face.vertices,
    center: face.centroid,
    area: face.area,
  };
}

/**
 * Check if two regions are duplicates (overlapping centroid + similar area).
 */
function isDuplicateRegion(a: SketchRegion, b: SketchRegion): boolean {
  if (Math.abs(a.area - b.area) / Math.max(a.area, b.area, 1) > 0.1) return false;
  const dx = a.center[0] - b.center[0];
  const dy = a.center[1] - b.center[1];
  return Math.sqrt(dx * dx + dy * dy) < 1; // within 1mm
}

export function detectSketchRegions(entities: Record<EntityId, SketchEntity>): SketchRegion[] {
  // Simple detectors: standalone circles and endpoint-connected boundary
  // loops (line / arc / Bézier edges). These preserve semantic shape
  // information (a `type: 'circle'` region knows it's a true circle, not
  // a polygon approximation; a loop's curve segments carry analytic data
  // for the kernel). There is no dedicated rectangle detector (invariant
  // #11 — no composite entities); rectangles arrive as 4 lines and feed
  // through `detectCurveLoopRegions`.
  const simpleRegions = [
    ...detectCircleRegions(entities),
    ...detectEllipseRegions(entities),
    ...detectClosedSplineRegions(entities),
    ...detectCurveLoopRegions(entities),
  ];

  // Planar graph detector: finds intersection regions (e.g., the lens
  // shape where a circle and rectangle overlap). These are always
  // `type: 'polygon'` with sampled vertices — even for what's logically a
  // circle, the graph layer can't recover the true curve.
  const planarFaces = detectIntersectionRegions(entities);
  const graphRegions = planarFaces.map((face, i) => planarFaceToRegion(face, i));

  // Merge: prefer simple regions for shapes the simple detectors found,
  // and add graph regions only for shapes the simple layer missed (true
  // intersection regions). Inverting the priority (simple wins) keeps the
  // circle-as-circle classification when a sketch contains a circle PLUS
  // other entities — without it, the graph region's polygon approximation
  // wins and the downstream kernel extrudes a polygonalized cylinder
  // with N strip-faces instead of one smooth lateral face.
  const merged: SketchRegion[] = [];

  for (const simple of simpleRegions) {
    merged.push(simple);
  }

  for (const gr of graphRegions) {
    const hasDuplicate = simpleRegions.some(s => isDuplicateRegion(s, gr));
    if (!hasDuplicate) {
      merged.push(gr);
    }
  }

  return assignHoles(merged.sort((a, b) => b.area - a.area || a.id.localeCompare(b.id)));
}

/**
 * Turn containment into holes: a region fully inside another *separate*
 * loop becomes that region's hole, so a circle inside a square makes the
 * square's region an annulus while the circle stays its own region. This
 * is the containment analogue of what the planar graph already does for
 * intersections — every bounded area is an independently-selectable
 * profile.
 *
 * Only loops with **disjoint entity sets** nest: a true inner loop shares
 * no edges with its container. This is what stops an *intersection*
 * sub-face (the lens between two overlapping circles shares both circle
 * entities) from being mistaken for a hole of the full circle — those are
 * already separate faces from the planar graph, not nested loops.
 */
export function assignHoles(regions: SketchRegion[]): SketchRegion[] {
  const n = regions.length;
  const entitySets = regions.map(r => new Set(r.allEntityIds.map(String)));
  const disjoint = (i: number, j: number): boolean => {
    for (const e of entitySets[i]!) if (entitySets[j]!.has(e)) return false;
    return true;
  };

  // parent[i] = the smallest separate region that strictly contains i.
  const parent: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestArea = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (
        regions[j]!.area > regions[i]!.area &&
        regions[j]!.area < bestArea &&
        disjoint(i, j) &&
        pointInRegionOuter(regions[i]!.center, regions[j]!)
      ) {
        bestArea = regions[j]!.area;
        parent[i] = j;
      }
    }
  }

  // Each region's holes = its direct children.
  return regions.map((region, i) => {
    const holes = regions.filter((_, j) => parent[j] === i);
    return holes.length > 0 ? { ...region, holes } : region;
  });
}

// --- Profile Resolution ---

/**
 * Check if two sets of entity IDs are equal (same elements, any order).
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/**
 * Test whether a 2D point is inside a polygon using ray casting.
 * Works for both convex and concave polygons.
 */
export function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  const [px, py] = point;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;

    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Test whether a 2D point is inside a circle region.
 */
function pointInCircleRegion(point: [number, number], center: [number, number], area: number): boolean {
  const radius = Math.sqrt(area / Math.PI);
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Test whether a 2D point is inside a region's *outer* boundary, ignoring
 * any nested holes. Used for containment (during hole assignment) and as
 * the basis of the hole-aware {@link pointInRegion}.
 */
export function pointInRegionOuter(point: [number, number], region: SketchRegion): boolean {
  if (region.type === 'circle') {
    return pointInCircleRegion(point, region.center, region.area);
  }
  // ellipse / closedSpline carry a sampled perimeter in `vertices`, so the
  // polygon ray-cast works the same as for polygon regions.
  return pointInPolygon(point, region.vertices);
}

/**
 * The region's outer boundary entities followed by those of its direct
 * holes. This is the full wire set of a ring: `[outer, inner]` for two
 * concentric circles. `resolveProfile` accepts it as a reference to the
 * ring, alongside the outer-boundary-only form.
 */
export function regionWireEntityIds(region: SketchRegion): EntityId[] {
  const ids = [...region.entityIds];
  for (const hole of region.holes ?? []) {
    for (const id of hole.entityIds) {
      if (!ids.some(existing => String(existing) === String(id))) ids.push(id);
    }
  }
  return ids;
}

/** Fillable area: the outer area minus each direct hole's area. */
export function regionNetArea(region: SketchRegion): number {
  let area = region.area;
  for (const hole of region.holes ?? []) area -= hole.area;
  return area;
}

/** Sample points on a region's outer boundary (circles carry no vertices). */
function regionOutlineSamples(region: SketchRegion): [number, number][] {
  if (region.type !== 'circle') return region.vertices;
  const radius = Math.sqrt(region.area / Math.PI);
  const samples: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    samples.push([
      region.center[0] + Math.cos(angle) * radius,
      region.center[1] + Math.sin(angle) * radius,
    ]);
  }
  return samples;
}

/**
 * A point inside the region's fillable area. The area centroid of a ring
 * sits in its hole (and a concave outline's can sit outside it), so when
 * `center` fails the hole-aware test this walks from the centre toward
 * the boundary samples until a point lands in the material.
 */
export function regionInteriorPoint(region: SketchRegion): [number, number] {
  if (pointInRegion(region.center, region)) return region.center;
  const [cx, cy] = region.center;
  for (const t of [0.5, 0.75, 0.25, 0.9, 0.1]) {
    for (const [px, py] of regionOutlineSamples(region)) {
      const candidate: [number, number] = [cx + (px - cx) * t, cy + (py - cy) * t];
      if (pointInRegion(candidate, region)) return candidate;
    }
  }
  return region.center;
}

/**
 * Fill holes that are themselves selected. Picking a ring and the disc
 * inside it means "the whole outer area", so the ring loses that hole and
 * the disc is dropped; the result extrudes as one face instead of two
 * bodies fused along the inner circle. A filled hole's own holes move up
 * to the outer region (a selected ring inside a selected ring keeps the
 * innermost hole open). Regions are matched by id, so pass regions from
 * one sketch only.
 */
export function fillSelectedHoles(selected: SketchRegion[]): SketchRegion[] {
  const byId = new Map<string, SketchRegion>();
  for (const region of selected) if (!byId.has(region.id)) byId.set(region.id, region);
  const filled = new Set<string>();
  const fill = (holes: SketchRegion[]): SketchRegion[] =>
    holes.flatMap(hole => {
      const picked = byId.get(hole.id);
      if (!picked) return [hole];
      filled.add(hole.id);
      return fill(picked.holes ?? []);
    });

  const withFilledHoles = [...byId.values()].map(region => {
    if (!region.holes || region.holes.length === 0) return region;
    const holes = fill(region.holes);
    if (holes.length === region.holes.length && holes.every((h, i) => h === region.holes![i])) {
      return region;
    }
    const next: SketchRegion = { ...region, holes };
    if (holes.length === 0) delete next.holes;
    return next;
  });
  return withFilledHoles.filter(region => !filled.has(region.id));
}

/**
 * Test whether a 2D point is inside a region's *fillable* area — inside its
 * outer boundary and NOT inside any nested hole. So clicking the gap of an
 * annulus selects the annulus, while clicking its centre selects the inner
 * disc region (which is the hole). Only direct holes are checked; deeper
 * nesting resolves because each hole is itself a region with its own holes.
 */
export function pointInRegion(point: [number, number], region: SketchRegion): boolean {
  if (!pointInRegionOuter(point, region)) return false;
  if (region.holes) {
    for (const hole of region.holes) {
      if (pointInRegionOuter(point, hole)) return false;
    }
  }
  return true;
}

/**
 * Resolve a ProfileRef against detected regions by entity-ID set equality,
 * with interior-point fallback for disambiguation.
 *
 * Resolution priority:
 * 1. Exact entity-ID set match (most common: standalone circle, rectangle)
 * 2. Exact match + interior point disambiguation (intersecting geometry)
 * 2b. Ring match: outer boundary + direct holes (`[outer, inner]`)
 * 3. Subset match (entity IDs are a subset of region's allEntityIds)
 * 3b. Subset of a ring's outer boundary + direct holes
 * 4. Fail -- no heuristics, no confidence scores
 */
export function resolveProfile(
  ref: ProfileRef,
  detectedRegions: SketchRegion[],
): ResolvedProfileResult {
  // Case 1: Empty wireEntityIds means "use all profiles" (entire sketch)
  if (ref.wireEntityIds.length === 0) {
    const firstRegion = detectedRegions[0];
    if (!firstRegion) {
      return {
        profileRef: ref,
        status: 'missing',
        error: 'No regions detected in sketch',
      };
    }
    // Return the largest region as a heuristic for "all profiles"
    return { profileRef: ref, status: 'resolved', region: firstRegion };
  }

  // Case 2: Find regions whose boundary entity IDs match exactly
  const entityIdSet = new Set(ref.wireEntityIds.map(String));
  const candidates = detectedRegions.filter(region => {
    const regionEntityIdSet = new Set(region.entityIds.map(String));
    return setsEqual(entityIdSet, regionEntityIdSet);
  });

  // A unique candidate wins outright; several are disambiguated by the
  // stored interior point. `undefined` means "try the next case".
  const pick = (found: SketchRegion[]): ResolvedProfileResult | undefined => {
    if (found.length === 1 && found[0]) {
      return { profileRef: ref, status: 'resolved', region: found[0] };
    }
    if (found.length > 1 && ref.interiorPoint) {
      const match = found.find(region => pointInRegion(ref.interiorPoint!, region));
      if (match) return { profileRef: ref, status: 'resolved', region: match };
    }
    return undefined;
  };

  const exact = pick(candidates);
  if (exact) return exact;

  // Case 2b: the full wire set of a ring — outer boundary plus its holes
  // (`[outer, inner]` for concentric circles).
  const ringWires = (region: SketchRegion): string[] => regionWireEntityIds(region).map(String);
  const holed = detectedRegions.filter(region => (region.holes?.length ?? 0) > 0);
  if (candidates.length === 0) {
    const ring = pick(holed.filter(region => setsEqual(entityIdSet, new Set(ringWires(region)))));
    if (ring) return ring;
  }

  // Case 3: Check if wireEntityIds are a subset (edge splitting at intersections)
  const subsetCandidates = detectedRegions.filter(region =>
    ref.wireEntityIds.every(id => region.allEntityIds.map(String).includes(String(id))),
  );
  const subset = pick(subsetCandidates);
  if (subset) return subset;

  // Case 3b: a subset of a ring's outer + hole wires (one edge of a
  // rectangle plus the circle inside it).
  if (subsetCandidates.length === 0) {
    const ringSubset = pick(holed.filter(region => {
      const wires = ringWires(region);
      return ref.wireEntityIds.every(id => wires.includes(String(id)));
    }));
    if (ringSubset) return ringSubset;
  }

  // Failed
  return {
    profileRef: ref,
    status: 'missing',
    error: `No region found matching entity IDs [${ref.wireEntityIds.join(', ')}]`,
  };
}

/**
 * Convert a detected region + sketch ID into a ProfileRef for storage.
 * Includes interiorPoint only when disambiguation is needed.
 */
export function regionToProfileRef(
  sketchId: FeatureId,
  region: SketchRegion,
  allRegions: SketchRegion[],
): ProfileRef {
  const entityIds = region.entityIds as EntityId[];

  // Check if disambiguation is needed: are there other regions with the same entity ID set?
  const entityIdSet = new Set(entityIds.map(String));
  const duplicates = allRegions.filter(other => {
    if (other.id === region.id) return false;
    const otherSet = new Set(other.entityIds.map(String));
    return setsEqual(entityIdSet, otherSet);
  });

  const result: ProfileRef = {
    sketchId,
    wireEntityIds: entityIds,
  };
  if (duplicates.length > 0) {
    result.interiorPoint = regionInteriorPoint(region);
  }
  return result;
}

/**
 * Find the region associated with a clicked sketch entity.
 * Handles single-entity regions (circles, closed curves) and
 * unambiguous multi-entity regions.
 */
export function findRegionForEntity(
  entityId: EntityId,
  regions: SketchRegion[],
): SketchRegion | null {
  // Check for single-entity regions (circles, closed curves)
  const singleEntityRegion = regions.find(
    r => r.entityIds.length === 1 && String(r.entityIds[0]) === String(entityId),
  );
  if (singleEntityRegion) return singleEntityRegion;

  // Check for regions where this entity participates in the boundary
  const participatingRegions = regions.filter(
    r => r.allEntityIds.some(id => String(id) === String(entityId)),
  );
  if (participatingRegions.length === 1) return participatingRegions[0] ?? null;

  // Ambiguous or no match -- require the user to click inside the region
  return null;
}

