import { canonicalBytes, type JsonValue } from '../canonical';
import { canonicalOrder, compareBytes, type JsonSet } from '../collections';
import {
  isUnsupportedFact,
  type BSplineCurve,
  type BSplineSurface,
  type EdgeGeometry,
  type FaceGeometry,
  type KernelFacts,
  type ShapeKey,
  type SurfaceFacts,
  type Vec3,
} from './facts';
import type { NamedEntity, NamedState } from './state';

/**
 * The 9.7 snapshot: `geometry`, a complete description of an entity, and the
 * comparison of two snapshots.
 *
 * Writing fixes an order so the bytes are canonical; comparing never depends
 * on that order. An edge matches in either direction, a loop under any
 * rotation, a set by one-to-one matching. A surface compares by what it is, not
 * by the frame the kernel holds it in. A fact the kernel cannot read leaves the
 * description absent (null), which rule 5 treats as no match, so the reference
 * asks.
 */

/** Differences two descriptions may have and still match. */
export interface Tolerance {
  /** mm. */
  position: number;
  /** Degrees. */
  direction: number;
  /** A size matches when the ratio of the two is within 1 ± this. */
  ratio: number;
}

/** 9.7: knots and curve parameters, whatever the tolerance. */
const KNOT_TOLERANCE = 1e-12;

/** 9.6 rule 5. `size` is the bounding-box diagonal of the part. */
export function tightTolerance(size: number): Tolerance {
  return { position: 1e-6 * size + 1e-9, direction: 1e-9, ratio: 1e-9 };
}

/** The 13.2 load check, loose enough that kernel versions reproduce it. `size` is the stored shape's diagonal. */
export function loadTolerance(size: number): Tolerance {
  return { position: 1e-6 * size + 1e-9, direction: 1e-6, ratio: 1e-6 };
}

export type CurveDescription =
  | { line: { start: Vec3; end: Vec3 } }
  | { circle: { center: Vec3; axis: Vec3; radius: number; start: Vec3; end: Vec3 } }
  | { ellipse: { center: Vec3; axis: Vec3; major: Vec3; radii: readonly [number, number]; start: Vec3; end: Vec3 } }
  | { bspline: BSplineCurve & { first: number; last: number } };

export interface EdgeDescription {
  edge: { closed: boolean; curve: CurveDescription };
}

interface AxisFrame {
  origin: Vec3;
  axis: Vec3;
  x: Vec3;
  radii: readonly number[];
}

export type SurfaceDescription =
  | { plane: { point: Vec3; normal: Vec3 } }
  | { cylinder: AxisFrame }
  | { cone: AxisFrame & { halfAngle: number } }
  | { sphere: AxisFrame }
  | { torus: AxisFrame }
  | { bspline: BSplineSurface };

export interface FaceDescription {
  /** `loops`: the outer loop, then the inner loops sorted by canonical bytes. */
  face: { surface: SurfaceDescription; loops: readonly (readonly EdgeDescription[])[] };
}

type FaceSet = { faces: JsonSet<FaceDescription> };

export type Description =
  | { vertex: { point: Vec3 } }
  | EdgeDescription
  | FaceDescription
  | { wire: { edges: readonly EdgeDescription[] } }
  | { shell: FaceSet }
  | { solid: FaceSet }
  | { body: FaceSet };

const negate = (v: Vec3): Vec3 => [0 - v[0], 0 - v[1], 0 - v[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** By x, then y, then z, as written doubles (9.7). */
function comparePoints(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function curveOf({ curve, start, end }: EdgeGeometry): CurveDescription {
  switch (curve.kind) {
    case 'line':
      return { line: { start, end } };
    case 'circle':
      return { circle: { center: curve.center, axis: curve.axis, radius: curve.radius, start, end } };
    case 'ellipse':
      return {
        ellipse: { center: curve.center, axis: curve.axis, major: curve.major, radii: curve.radii, start, end },
      };
    case 'bspline': {
      const { degree, poles, weights, knots, multiplicities, first, last } = curve;
      return { bspline: { degree, poles, weights, knots, multiplicities, first, last } };
    }
  }
}

function reversedCurve(curve: CurveDescription): CurveDescription {
  if ('line' in curve) return { line: { start: curve.line.end, end: curve.line.start } };
  if ('circle' in curve) {
    const c = curve.circle;
    return { circle: { ...c, axis: negate(c.axis), start: c.end, end: c.start } };
  }
  if ('ellipse' in curve) {
    const e = curve.ellipse;
    return { ellipse: { ...e, axis: negate(e.axis), start: e.end, end: e.start } };
  }
  const b = curve.bspline;
  return {
    bspline: {
      ...b,
      poles: [...b.poles].reverse(),
      weights: [...b.weights].reverse(),
      // Reflected in the edge's own range, which keeps `first` and `last`.
      knots: [...b.knots].reverse().map((k) => b.first + b.last - k),
      multiplicities: [...b.multiplicities].reverse(),
    },
  };
}

const reversedEdge = ({ edge }: EdgeDescription): EdgeDescription => ({
  edge: { closed: edge.closed, curve: reversedCurve(edge.curve) },
});

/** An edge on its own: an open edge from its smaller end, a closed one from its parametric start. */
export function writeEdge(geometry: EdgeGeometry): EdgeDescription {
  const edge: EdgeDescription = { edge: { closed: geometry.closed, curve: curveOf(geometry) } };
  return !geometry.closed && comparePoints(geometry.end, geometry.start) < 0 ? reversedEdge(edge) : edge;
}

/** Compares the cycle read from `a` with the one read from `b`, byte by byte. */
function compareRotations(bytes: readonly Uint8Array[], a: number, b: number): number {
  for (let i = 0; i < bytes.length; i++) {
    const order = compareBytes(
      bytes[(a + i) % bytes.length] as Uint8Array,
      bytes[(b + i) % bytes.length] as Uint8Array,
    );
    if (order !== 0) return order;
  }
  return 0;
}

/** A cycle starting at its smallest edge; equal edges are settled by what follows them. */
function fromSmallest(cycle: readonly EdgeDescription[]): EdgeDescription[] {
  const bytes = cycle.map((e) => canonicalBytes(e));
  let start = 0;
  for (let i = 1; i < cycle.length; i++) if (compareRotations(bytes, i, start) < 0) start = i;
  return [...cycle.slice(start), ...cycle.slice(0, start)];
}

/** A cycle of edge uses, each edge written in its direction of travel. */
function writeCycle(uses: FaceGeometry['loops'][number], facts: KernelFacts): EdgeDescription[] {
  const cycle = uses.map(({ edge, reversed }) => {
    const geometry = facts.edgeGeometry(edge);
    const forward: EdgeDescription = { edge: { closed: geometry.closed, curve: curveOf(geometry) } };
    return reversed ? reversedEdge(forward) : forward;
  });
  return fromSmallest(cycle);
}

function writeSurface(surface: SurfaceFacts): SurfaceDescription {
  switch (surface.kind) {
    case 'plane':
      return { plane: { point: surface.point, normal: surface.normal } };
    case 'bspline': {
      const { degrees, poles, weights, knots, multiplicities } = surface;
      return { bspline: { degrees, poles, weights, knots, multiplicities } };
    }
    case 'cone': {
      const { origin, axis, x, radii, halfAngle } = surface;
      return { cone: { origin, axis, x, radii, halfAngle: halfAngle as number } };
    }
    default: {
      const { kind, origin, axis, x, radii } = surface;
      const frame: AxisFrame = { origin, axis, x, radii };
      return kind === 'cylinder' ? { cylinder: frame } : kind === 'sphere' ? { sphere: frame } : { torus: frame };
    }
  }
}

function writeFace(face: ShapeKey, facts: KernelFacts): FaceDescription {
  const { surface, loops } = facts.faceGeometry(face);
  const [outer, ...inner] = loops.map((loop) => writeCycle(loop, facts));
  return { face: { surface: writeSurface(surface), loops: outer ? [outer, ...canonicalOrder(inner)] : [] } };
}

/** Null when the kernel cannot read a fact the description needs. */
function unlessUnsupported<T>(read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    if (isUnsupportedFact(e)) return null;
    throw e;
  }
}

export function describeVertex(vertex: ShapeKey, facts: KernelFacts): Description | null {
  const { point } = facts.measures(vertex);
  return point ? { vertex: { point } } : null;
}

export function describeEdge(edge: ShapeKey, facts: KernelFacts): Description | null {
  return unlessUnsupported(() => writeEdge(facts.edgeGeometry(edge)));
}

export function describeFace(face: ShapeKey, facts: KernelFacts): Description | null {
  return unlessUnsupported(() => writeFace(face, facts));
}

/** A wire is a cycle of edge uses, in the form `FaceGeometry.loops` gives them. */
export function describeWire(uses: FaceGeometry['loops'][number], facts: KernelFacts): Description | null {
  return unlessUnsupported(() => ({ wire: { edges: writeCycle(uses, facts) } }));
}

/** A shell, solid or body: the set of its faces. */
export function describeFaces(
  kind: 'shell' | 'solid' | 'body',
  faces: readonly ShapeKey[],
  facts: KernelFacts,
): Description | null {
  return unlessUnsupported(() => {
    const set: FaceSet = { faces: { set: canonicalOrder(faces.map((f) => writeFace(f, facts))) } };
    return kind === 'shell' ? { shell: set } : kind === 'solid' ? { solid: set } : { body: set };
  });
}

/** The `geometry` of a named entity. Null for a kind 9.7 gives none, or when the kernel cannot read it. */
export function describeEntity(entity: NamedEntity, facts: KernelFacts): Description | null {
  switch (entity.kind) {
    case 'vertex':
      return describeVertex(entity.key, facts);
    case 'edge':
      return describeEdge(entity.key, facts);
    case 'face':
      return describeFace(entity.key, facts);
    case 'body': {
      const solid = facts.topology(entity.body).solids.find((s) => s.solid === entity.key);
      return solid ? describeFaces('body', solid.faces, facts) : null;
    }
    default:
      return null;
  }
}

function samePoint(a: Vec3, b: Vec3, t: Tolerance): boolean {
  return norm(subtract(a, b)) <= t.position;
}

function sameSize(a: number, b: number, t: Tolerance): boolean {
  return Math.abs(a - b) <= t.ratio * Math.max(Math.abs(a), Math.abs(b));
}

/** The angle between two directions by its sine and cosine: `acos` has no resolution at 1e-9°. */
function sameDirection(a: Vec3, b: Vec3, t: Tolerance): boolean {
  return (Math.atan2(norm(cross(a, b)), dot(a, b)) * 180) / Math.PI <= t.direction;
}

function sameDirectionUpToSign(a: Vec3, b: Vec3, t: Tolerance): boolean {
  return (Math.atan2(norm(cross(a, b)), Math.abs(dot(a, b))) * 180) / Math.PI <= t.direction;
}

function sameSizes(a: readonly number[], b: readonly number[], t: Tolerance): boolean {
  return a.length === b.length && a.every((v, i) => sameSize(v, b[i] as number, t));
}

function samePoints(a: readonly Vec3[], b: readonly Vec3[], t: Tolerance): boolean {
  return a.length === b.length && a.every((p, i) => samePoint(p, b[i] as Vec3, t));
}

const sameIntegers = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sameKnots = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) <= KNOT_TOLERANCE);

/** One member of `a` for each of `b`. Tolerances do not chain, so a greedy pairing could fail where one exists. */
function matchOneToOne<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean {
  if (a.length !== b.length) return false;
  const owner = new Array<number>(b.length).fill(-1);
  const assign = (i: number, seen: Set<number>): boolean => {
    for (let j = 0; j < b.length; j++) {
      if (seen.has(j) || !same(a[i] as T, b[j] as T)) continue;
      seen.add(j);
      const holder = owner[j] as number;
      if (holder < 0 || assign(holder, seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };
  return a.every((_, i) => assign(i, new Set()));
}

function sameCurve(a: CurveDescription, b: CurveDescription, closed: boolean, t: Tolerance): boolean {
  const sameEnds = (x: { start: Vec3; end: Vec3 }, y: { start: Vec3; end: Vec3 }): boolean =>
    closed || (samePoint(x.start, y.start, t) && samePoint(x.end, y.end, t));
  if ('line' in a) {
    // A closed line is a degenerate edge: its one point is all there is.
    return 'line' in b && samePoint(a.line.start, b.line.start, t) && samePoint(a.line.end, b.line.end, t);
  }
  if ('circle' in a) {
    if (!('circle' in b)) return false;
    const [x, y] = [a.circle, b.circle];
    return (
      samePoint(x.center, y.center, t) &&
      sameDirection(x.axis, y.axis, t) &&
      sameSize(x.radius, y.radius, t) &&
      sameEnds(x, y)
    );
  }
  if ('ellipse' in a) {
    if (!('ellipse' in b)) return false;
    const [x, y] = [a.ellipse, b.ellipse];
    return (
      samePoint(x.center, y.center, t) &&
      sameDirection(x.axis, y.axis, t) &&
      sameDirectionUpToSign(x.major, y.major, t) &&
      sameSizes(x.radii, y.radii, t) &&
      sameEnds(x, y)
    );
  }
  if (!('bspline' in b)) return false;
  const [x, y] = [a.bspline, b.bspline];
  return (
    x.degree === y.degree &&
    samePoints(x.poles, y.poles, t) &&
    sameSizes(x.weights, y.weights, t) &&
    sameKnots(x.knots, y.knots) &&
    sameIntegers(x.multiplicities, y.multiplicities) &&
    sameKnots([x.first, x.last], [y.first, y.last])
  );
}

/** A standalone edge matches in either direction (9.7). */
function sameEdge(a: EdgeDescription, b: EdgeDescription, t: Tolerance): boolean {
  if (a.edge.closed !== b.edge.closed) return false;
  return (
    sameCurve(a.edge.curve, b.edge.curve, a.edge.closed, t) ||
    sameCurve(a.edge.curve, reversedCurve(b.edge.curve), a.edge.closed, t)
  );
}

/** An edge inside a loop or wire runs in the travel direction, so it matches only in that direction (9.7). */
function sameDirectedEdge(a: EdgeDescription, b: EdgeDescription, t: Tolerance): boolean {
  return a.edge.closed === b.edge.closed && sameCurve(a.edge.curve, b.edge.curve, a.edge.closed, t);
}

/** Distance from a point to the line through `origin` along `axis`. */
function distanceToLine(point: Vec3, origin: Vec3, axis: Vec3): number {
  return norm(cross(subtract(point, origin), axis)) / norm(axis);
}

/** Where a cone's radius reaches zero; the frame's origin and its radius there are only one section of it. */
function apex({ origin, axis, radii, halfAngle }: AxisFrame & { halfAngle: number }): Vec3 {
  const angle = (halfAngle * Math.PI) / 180;
  const along = ((radii[0] as number) * Math.cos(angle)) / Math.sin(angle);
  const length = norm(axis);
  return [
    origin[0] - (along * axis[0]) / length,
    origin[1] - (along * axis[1]) / length,
    origin[2] - (along * axis[2]) / length,
  ];
}

function sameBSplineSurface(a: BSplineSurface, b: BSplineSurface, t: Tolerance): boolean {
  return (
    sameIntegers(a.degrees, b.degrees) &&
    a.poles.length === b.poles.length &&
    a.poles.every((row, i) => samePoints(row, b.poles[i] as readonly Vec3[], t)) &&
    a.weights.length === b.weights.length &&
    a.weights.every((row, i) => sameSizes(row, b.weights[i] as readonly number[], t)) &&
    sameKnots(a.knots[0], b.knots[0]) &&
    sameKnots(a.knots[1], b.knots[1]) &&
    sameIntegers(a.multiplicities[0], b.multiplicities[0]) &&
    sameIntegers(a.multiplicities[1], b.multiplicities[1])
  );
}

function sameSurface(a: SurfaceDescription, b: SurfaceDescription, t: Tolerance): boolean {
  if ('plane' in a) {
    if (!('plane' in b)) return false;
    const [x, y] = [a.plane, b.plane];
    return (
      sameDirection(x.normal, y.normal, t) && Math.abs(dot(x.point, x.normal) - dot(y.point, y.normal)) <= t.position
    );
  }
  if ('cylinder' in a) {
    if (!('cylinder' in b)) return false;
    const [x, y] = [a.cylinder, b.cylinder];
    return (
      sameDirectionUpToSign(x.axis, y.axis, t) &&
      distanceToLine(x.origin, y.origin, y.axis) <= t.position &&
      sameSizes(x.radii, y.radii, t)
    );
  }
  if ('cone' in a) {
    if (!('cone' in b)) return false;
    const [x, y] = [a.cone, b.cone];
    return (
      sameDirectionUpToSign(x.axis, y.axis, t) &&
      samePoint(apex(x), apex(y), t) &&
      Math.abs(Math.abs(x.halfAngle) - Math.abs(y.halfAngle)) <= t.direction
    );
  }
  if ('sphere' in a) {
    // A sphere has no axis of its own: centre and radius are all of it.
    if (!('sphere' in b)) return false;
    return samePoint(a.sphere.origin, b.sphere.origin, t) && sameSizes(a.sphere.radii, b.sphere.radii, t);
  }
  if ('torus' in a) {
    if (!('torus' in b)) return false;
    const [x, y] = [a.torus, b.torus];
    return (
      samePoint(x.origin, y.origin, t) && sameDirectionUpToSign(x.axis, y.axis, t) && sameSizes(x.radii, y.radii, t)
    );
  }
  return 'bspline' in b && sameBSplineSurface(a.bspline, b.bspline, t);
}

function sameCycle(a: readonly EdgeDescription[], b: readonly EdgeDescription[], t: Tolerance): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  for (let r = 0; r < b.length; r++) {
    if (a.every((e, i) => sameDirectedEdge(e, b[(i + r) % b.length] as EdgeDescription, t))) return true;
  }
  return false;
}

function sameFace(a: FaceDescription, b: FaceDescription, t: Tolerance): boolean {
  const [outerA, ...innerA] = a.face.loops;
  const [outerB, ...innerB] = b.face.loops;
  return (
    sameSurface(a.face.surface, b.face.surface, t) &&
    a.face.loops.length === b.face.loops.length &&
    (outerA === undefined || sameCycle(outerA, outerB as readonly EdgeDescription[], t)) &&
    matchOneToOne(innerA, innerB, (x, y) => sameCycle(x, y, t))
  );
}

function sameFaces(a: FaceSet, b: FaceSet, t: Tolerance): boolean {
  return matchOneToOne(a.faces.set, b.faces.set, (x, y) => sameFace(x, y, t));
}

function sameDescription(a: Description, b: Description, t: Tolerance): boolean {
  if ('vertex' in a) return 'vertex' in b && samePoint(a.vertex.point, b.vertex.point, t);
  if ('edge' in a) return 'edge' in b && sameEdge(a, b, t);
  if ('face' in a) return 'face' in b && sameFace(a, b, t);
  if ('wire' in a) return 'wire' in b && sameCycle(a.wire.edges, b.wire.edges, t);
  if ('shell' in a) return 'shell' in b && sameFaces(a.shell, b.shell, t);
  if ('solid' in a) return 'solid' in b && sameFaces(a.solid, b.solid, t);
  return 'body' in b && sameFaces(a.body, b.body, t);
}

/**
 * Whether two `geometry` descriptions match (9.7). A stored description comes
 * from a document, so one of the wrong shape matches nothing.
 */
export function matchesDescription(a: unknown, b: unknown, tolerance: Tolerance): boolean {
  try {
    return sameDescription(a as Description, b as Description, tolerance);
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

/** Rule 5's comparison for references resolving against `state`. */
export function tightMatcher(
  state: NamedState,
  facts: KernelFacts,
): (entity: NamedEntity, geometry: JsonValue) => boolean {
  const tolerance = tightTolerance(partSize(state, facts));
  return (entity, geometry) => {
    const description = describeEntity(entity, facts);
    return description !== null && matchesDescription(geometry, description, tolerance);
  };
}

/** The diagonal of a bounding box; 0 without one. */
export function diagonal(box: readonly [Vec3, Vec3] | undefined): number {
  return box ? norm(subtract(box[1], box[0])) : 0;
}

/** The bounding-box diagonal of a part in a state (9.6 rule 5). */
export function partSize(state: NamedState, facts: KernelFacts): number {
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const body of state.bodies.keys()) {
    const box = facts.measures(body).bbox;
    if (!box) continue;
    any = true;
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i] as number, box[0][i] as number);
      high[i] = Math.max(high[i] as number, box[1][i] as number);
    }
  }
  return any ? diagonal([low, high]) : 0;
}

type Measure = (a: never, b: never, t: Tolerance) => boolean;

/** How each measure compares. Quarter points pair up below, since a direction can flip by rounding. */
const MEASURES: Record<string, Measure> = {
  centroid: samePoint,
  midpoint: samePoint,
  center: samePoint,
  point: samePoint,
  normal: sameDirection,
  axis: sameDirectionUpToSign,
  tangent: sameDirectionUpToSign,
  area: sameSize,
  length: sameSize,
  volume: sameSize,
  surface: (a, b) => a === b,
  curve: (a, b) => a === b,
  bbox: (a: readonly Vec3[], b: readonly Vec3[], t) => samePoints(a, b, t),
  vertices: (a: readonly Vec3[], b: readonly Vec3[], t) => matchOneToOne(a, b, (x, y) => samePoint(x, y, t)),
};

function sameQuarters(a: Record<string, JsonValue>, b: Record<string, JsonValue>, t: Tolerance): boolean {
  if (a.quarter === undefined && a.threeQuarter === undefined) return true;
  const [q, r, s, u] = [a.quarter, a.threeQuarter, b.quarter, b.threeQuarter] as unknown as Vec3[];
  return (
    (samePoint(q as Vec3, s as Vec3, t) && samePoint(r as Vec3, u as Vec3, t)) ||
    (samePoint(q as Vec3, u as Vec3, t) && samePoint(r as Vec3, s as Vec3, t))
  );
}

/**
 * Whether a live sub-shape's snapshot agrees with a stored one (13.2, and the
 * settling check of 12.4). Every measure stored must hold on `live`, `geometry`
 * included: a stored description this kernel cannot produce live is a
 * mismatch, never left to the other measures.
 */
export function matchesSnapshot(
  stored: Record<string, JsonValue>,
  live: Record<string, JsonValue>,
  tolerance: Tolerance,
): boolean {
  try {
    for (const [key, compare] of Object.entries(MEASURES)) {
      const value = stored[key];
      if (value === undefined) continue;
      if (live[key] === undefined || !compare(value as never, live[key] as never, tolerance)) return false;
    }
    if (!sameQuarters(stored, live, tolerance)) return false;
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
  const [a, b] = [stored.geometry, live.geometry];
  return a === undefined || (b !== undefined && matchesDescription(a, b, tolerance));
}
