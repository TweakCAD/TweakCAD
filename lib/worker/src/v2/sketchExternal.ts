/**
 * External curves of a sketch (8.1 `external`): model geometry brought into
 * the sketch plane, resolved in the part as it stands before the sketch.
 *
 * - `project` takes one edge and projects it along the sketch normal: a line
 *   stays a line, a circle or an ellipse becomes a circle, an ellipse or an
 *   arc of one, and a B-spline the B-spline over its projected poles (a
 *   parallel projection is affine, so all of these are exact).
 * - `intersect` takes a face or a body and cuts it with the sketch plane; the
 *   kernel keeps the section's analytic curves.
 * - `silhouette` takes a cylinder, cone or sphere face and finds where its
 *   surface turns away from the sketch normal: the generators of a cylinder
 *   or cone, a sphere's great circle, each trimmed to the face.
 *
 * Every curve runs in its format direction: a line from its end smaller by
 * x, then y, in the sketch frame (9.7's writing order), circles, ellipses and
 * their arcs counter-clockwise, an open B-spline from its smaller end and a
 * closed one counter-clockwise. A row that cannot be built (its external
 * link broken) pauses its sketch.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { prepareCurve, type CurveShape, type Vec2 } from '@tweakcad/format';
import { curveFacts } from '@tweakcad/kernel/src/namingAdapterGeometry.ts';
import { NamingAdapterError } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  FLAG,
  FeaturePause,
  add,
  cross,
  dot,
  kv,
  norm,
  scale,
  sub,
  unit,
  type BuildContext,
  type Frame,
  type Json,
  type V3,
} from './context';
import { entityOf } from './places';
import { segment } from './curveEdges';

/** One external row as built in this evaluation. */
export interface ExternalCurve {
  id: string;
  shape: CurveShape;
  /** Whether it bounds regions: `defining` and not construction. */
  bounds: boolean;
}

/** A curve in the part, in a form a parallel projection maps exactly. */
type Curve3 =
  | { kind: 'line'; a: V3; b: V3 }
  /** P(t) = center + u cos t + v sin t over t0..t1 (u and v conjugate radii). */
  | { kind: 'conic'; center: V3; u: V3; v: V3; t0: number; t1: number; closed: boolean }
  | {
      kind: 'nurbs';
      degree: number;
      poles: V3[];
      weights: number[];
      knots: number[];
      multiplicities: number[];
      periodic: boolean;
    };

const TAU = 2 * Math.PI;

/** Within rounding of each other, relative to their size. */
const level = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * (1 + Math.max(Math.abs(a), Math.abs(b)));

/** Orders sketch-plane points by x, then y, equal within rounding. */
function comparePoints(a: Vec2, b: Vec2): number {
  if (!level(a[0], b[0])) return a[0] - b[0];
  if (!level(a[1], b[1])) return a[1] - b[1];
  return 0;
}

const angleMod = (t: number) => ((t % TAU) + TAU) % TAU;

/** The exact curve of a kernel edge, over its own parameter range. */
function edgeCurve(k: OcctKernel, edge: ShapeHandle): Curve3 {
  const kind = k.curveType(edge);
  const { first, last } = k.curveParameters(edge);
  const at = (t: number): V3 => {
    const p = k.curvePointAtParam(edge, t);
    return [p.x, p.y, p.z];
  };
  let facts;
  try {
    facts = curveFacts(k, edge, kind);
  } catch (e) {
    if (e instanceof NamingAdapterError) throw new FeaturePause(`the kernel gives no exact data for a ${kind} edge`);
    throw e;
  }
  const closed = k.curveIsClosed(edge);
  switch (facts.kind) {
    case 'line':
      return { kind: 'line', a: at(first), b: at(last) };
    case 'circle':
    case 'ellipse': {
      const center = facts.center as V3;
      const axis = facts.axis as V3;
      const [x, radii] =
        facts.kind === 'circle'
          ? [unit(sub(at(first), center)), [facts.radius, facts.radius]]
          : [facts.major as V3, facts.radii];
      const u = scale(x, radii[0] as number);
      const v = scale(cross(axis, x), radii[1] as number);
      // The parameter of a point on the curve, counted from u.
      const param = (p: V3) => {
        const d = sub(p, center);
        return Math.atan2(dot(d, v) / dot(v, v), dot(d, u) / dot(u, u));
      };
      const t0 = param(at(first));
      if (closed) return { kind: 'conic', center, u, v, t0, t1: t0 + TAU, closed };
      const sweep = angleMod(param(at(last)) - t0);
      return { kind: 'conic', center, u, v, t0, t1: t0 + (sweep > 0 ? sweep : TAU), closed };
    }
    case 'bspline': {
      let data = k.getNurbsCurveData(edge);
      const knots = data.knots;
      const [k0, kn] = [knots[0] as number, knots[knots.length - 1] as number];
      const slack = 1e-12 * (kn - k0);
      if (first > k0 + slack || last < kn - slack) {
        // A trimmed edge of a longer curve: its own stretch, exactly.
        if (data.periodic) throw new FeaturePause('a trimmed periodic B-spline edge is not projected yet');
        const weights = data.weights.length > 0 ? data.weights : data.poles.filter((_, i) => i % 3 === 0).map(() => 1);
        const full = k.makeBSplineEdge(data.poles, weights, data.knots, data.multiplicities, data.degree, false);
        data = k.getNurbsCurveData(segment(k, full, k0, kn, first, last));
      }
      const poles: V3[] = [];
      for (let i = 0; i + 2 < data.poles.length; i += 3)
        poles.push([data.poles[i] as number, data.poles[i + 1] as number, data.poles[i + 2] as number]);
      return {
        kind: 'nurbs',
        degree: data.degree,
        poles,
        weights: data.weights.length === poles.length ? [...data.weights] : poles.map(() => 1),
        knots: [...data.knots],
        multiplicities: [...data.multiplicities],
        periodic: data.periodic,
      };
    }
  }
}

/** Projects part points and vectors into the sketch frame. */
function projector(frame: Frame) {
  return {
    point: (p: V3): Vec2 => {
      const d = sub(p, frame.origin);
      return [dot(d, frame.x), dot(d, frame.y)];
    },
    vector: (v: V3): Vec2 => [dot(v, frame.x), dot(v, frame.y)],
  };
}

const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len2 = (a: Vec2) => Math.hypot(a[0], a[1]);

/** A projected conic in principal form: P(t) = c + A cos(t − s) + B sin(t − s), |A| ≥ |B|. */
function principal(c: Vec2, u: Vec2, v: Vec2) {
  const s0 = 0.5 * Math.atan2(2 * dot2(u, v), dot2(u, u) - dot2(v, v));
  const along = (s: number): [Vec2, Vec2] => [
    [u[0] * Math.cos(s) + v[0] * Math.sin(s), u[1] * Math.cos(s) + v[1] * Math.sin(s)],
    [-u[0] * Math.sin(s) + v[0] * Math.cos(s), -u[1] * Math.sin(s) + v[1] * Math.cos(s)],
  ];
  let s = s0;
  let [a, b] = along(s);
  if (len2(a) < len2(b)) {
    s = s0 + Math.PI / 2;
    [a, b] = along(s);
  }
  const point = (t: number): Vec2 => [
    c[0] + u[0] * Math.cos(t) + v[0] * Math.sin(t),
    c[1] + u[1] * Math.cos(t) + v[1] * Math.sin(t),
  ];
  return { major: a, minor: len2(b), point };
}

/** The end of an ellipse's major axis the format starts it from: the one with the larger x, then the larger y. */
function majorEnd(c: Vec2, a: Vec2): Vec2 {
  const p: Vec2 = [c[0] + a[0], c[1] + a[1]];
  const q: Vec2 = [c[0] - a[0], c[1] - a[1]];
  return comparePoints(p, q) >= 0 ? p : q;
}

function reversedNurbs(shape: Extract<CurveShape, { kind: 'nurbs' }>): Extract<CurveShape, { kind: 'nurbs' }> {
  const [k0, kn] = [shape.knots[0] as number, shape.knots[shape.knots.length - 1] as number];
  return {
    ...shape,
    poles: [...shape.poles].reverse(),
    weights: [...shape.weights].reverse(),
    knots: shape.knots.map((t) => k0 + kn - t).reverse(),
    multiplicities: [...shape.multiplicities].reverse(),
  };
}

/** The signed area a closed curve encloses, by a fine polygon: positive when it runs counter-clockwise. */
function signedArea(shape: CurveShape): number {
  const curve = prepareCurve(shape, true);
  if (!curve) return 0;
  const steps = 1024;
  let sum = 0;
  let p = curve.point(curve.tMin);
  for (let i = 1; i <= steps; i++) {
    const q = curve.point(curve.tMin + ((curve.tMax - curve.tMin) * i) / steps);
    sum += cross2(p, q) / 2;
    p = q;
  }
  return sum;
}

/** A part curve projected along the sketch normal, in its format direction. */
function project(frame: Frame, c: Curve3): CurveShape {
  const to = projector(frame);
  switch (c.kind) {
    case 'line': {
      const [a, b] = [to.point(c.a), to.point(c.b)];
      if (comparePoints(a, b) === 0) throw new FeaturePause('the edge projects to a point');
      return comparePoints(a, b) < 0 ? { kind: 'line', start: a, end: b } : { kind: 'line', start: b, end: a };
    }
    case 'conic': {
      const [center, u, v] = [to.point(c.center), to.vector(c.u), to.vector(c.v)];
      const turn = cross2(u, v);
      if (Math.abs(turn) <= 1e-9 * norm(c.u) * norm(c.v))
        throw new FeaturePause('the curve lies edge-on to the sketch plane and projects to a line');
      const { major, minor, point } = principal(center, u, v);
      const radius = len2(major);
      const round = level(radius, minor);
      if (c.closed) {
        return round
          ? { kind: 'circle', center, radius: (radius + minor) / 2 }
          : { kind: 'ellipse', center, majorEnd: majorEnd(center, major), minorRadius: minor };
      }
      // Counter-clockwise in the sketch: along the parameter when the projection keeps its turn.
      const [start, end] = turn > 0 ? [point(c.t0), point(c.t1)] : [point(c.t1), point(c.t0)];
      return round
        ? { kind: 'arc', center, start, end }
        : { kind: 'ellipticalArc', center, majorEnd: majorEnd(center, major), minorRadius: minor, start, end };
    }
    case 'nurbs': {
      const shape: Extract<CurveShape, { kind: 'nurbs' }> = {
        kind: 'nurbs',
        degree: c.degree,
        poles: c.poles.map(to.point),
        weights: c.weights,
        knots: c.knots,
        multiplicities: c.multiplicities,
        periodic: c.periodic,
      };
      const curve = prepareCurve(shape, false);
      if (!curve) throw new FeaturePause('the edge projects to a point');
      const [a, b] = [curve.point(curve.tMin), curve.point(curve.tMax)];
      if (c.periodic || comparePoints(a, b) === 0) return signedArea(shape) >= 0 ? shape : reversedNurbs(shape);
      return comparePoints(a, b) < 0 ? shape : reversedNurbs(shape);
    }
  }
}

/** A curve's start and end in its format direction, for ordering several. */
function endsOf(shape: CurveShape): [Vec2, Vec2] {
  switch (shape.kind) {
    case 'line':
    case 'arc':
    case 'ellipticalArc':
      return [shape.start, shape.end];
    case 'circle': {
      const p: Vec2 = [shape.center[0] + shape.radius, shape.center[1]];
      return [p, p];
    }
    case 'ellipse':
      return [shape.majorEnd, shape.majorEnd];
    default: {
      const curve = prepareCurve(shape, false);
      if (!curve) throw new FeaturePause('an external curve has no extent');
      return [curve.point(curve.tMin), curve.point(curve.tMax)];
    }
  }
}

/** The curves of a compound of edges, in the part. */
function edgesOf(k: OcctKernel, compound: ShapeHandle): Curve3[] {
  return k.getSubShapes(compound, 'edge').map((e) => edgeCurve(k, e));
}

/** Where a cylinder, cone or sphere face turns away from the view along `n`, trimmed to the face. */
function silhouetteOf(ctx: BuildContext, ref: Json, n: V3): Curve3[] {
  const { kernel: k, adapter } = ctx.ev;
  const face = entityOf(ctx, ref, 'the source of a silhouette');
  if (face.kind !== 'face') throw new FeaturePause('a silhouette is taken of a face');
  const s = adapter.faceGeometry(face.key).surface;
  const handle = adapter.handleOf(face.key);
  if (s.kind === 'sphere') return edgesOf(k, k.sectionPlane(handle, kv(s.origin as V3), kv(n)));
  if (s.kind === 'cylinder') {
    // The two generators whose normal is square to the view lie in the plane through the axis and the view.
    const axis = unit(s.axis as V3);
    const across = sub(n, scale(axis, dot(n, axis)));
    if (norm(across) <= 1e-9) return [];
    return edgesOf(k, k.sectionPlane(handle, kv(s.origin as V3), kv(unit(across))));
  }
  if (s.kind === 'cone') {
    const axis = unit(s.axis as V3);
    const x = unit(s.x as V3);
    const y = cross(axis, x);
    const half = ((s.halfAngle ?? 0) * Math.PI) / 180;
    const apex = sub(s.origin as V3, scale(axis, (s.radii[0] as number) / Math.tan(half)));
    // A generator's normal is square to the view where cos α (cos θ x·n + sin θ y·n) = sin α a·n.
    const [xn, yn] = [dot(x, n), dot(y, n)];
    const rho = Math.hypot(xn, yn);
    const rhs = rho === 0 ? Infinity : (Math.tan(half) * dot(axis, n)) / rho;
    if (!(Math.abs(rhs) < 1)) return [];
    const phi = Math.atan2(yn, xn);
    const out: Curve3[] = [];
    for (const theta of [phi + Math.acos(rhs), phi - Math.acos(rhs)]) {
      const g = add(
        scale(axis, Math.cos(half)),
        scale(add(scale(x, Math.cos(theta)), scale(y, Math.sin(theta))), Math.sin(half)),
      );
      const normal = cross(g, n);
      if (norm(normal) <= 1e-9) throw new FeaturePause('the view runs along a generator of the cone');
      for (const c of edgesOf(k, k.sectionPlane(handle, kv(apex), kv(unit(normal))))) {
        if (c.kind === 'line' && norm(cross(unit(sub(c.b, c.a)), g)) <= 1e-7) out.push(c);
      }
    }
    return out;
  }
  throw new FeaturePause(`the silhouette of a ${s.kind} face is not built yet`);
}

/** The part curves an external row's mode makes from its source. */
function sourceCurves(ctx: BuildContext, row: Json, mode: string, frame: Frame): Curve3[] {
  const { kernel: k, adapter } = ctx.ev;
  const ref = row.source as Json;
  if (!('entity' in ref)) throw new FeaturePause('an external curve takes a model entity as its source');
  switch (mode) {
    case 'project': {
      const edge = entityOf(ctx, ref, 'the source');
      if (edge.kind !== 'edge')
        throw new FeaturePause(
          'a projected curve takes one edge; a face is projected as one row per edge of its boundary',
        );
      return [edgeCurve(k, adapter.handleOf(edge.key))];
    }
    case 'intersect': {
      const source = entityOf(ctx, ref, 'the source');
      if (source.kind !== 'face' && source.kind !== 'body')
        throw new FeaturePause('an intersection takes a face or a body');
      return edgesOf(k, k.sectionPlane(adapter.handleOf(source.key), kv(frame.origin), kv(frame.normal)));
    }
    case 'silhouette':
      return silhouetteOf(ctx, ref, frame.normal);
    default:
      throw new FeaturePause(`the external mode ${mode} is not built yet`);
  }
}

/** Curves in the order `index` counts them (8.1): by start point, then end point. */
function sortedByEnds(shapes: readonly CurveShape[]): { shape: CurveShape; ends: [Vec2, Vec2] }[] {
  return shapes
    .map((shape) => ({ shape, ends: endsOf(shape) }))
    .sort((a, b) => comparePoints(a.ends[0], b.ends[0]) || comparePoints(a.ends[1], b.ends[1]));
}

/**
 * The curves an external row of `mode` takes from a model edge, face or
 * body, in the sketch frame and in the order `index` counts them: what an
 * editor writes `index`, `count` and `near` from when it makes the rows.
 */
export function externalCandidates(
  k: OcctKernel,
  handle: ShapeHandle,
  kind: string,
  mode: 'project' | 'intersect',
  frame: Frame,
): CurveShape[] {
  if (mode === 'project') {
    if (kind !== 'edge') throw new FeaturePause('a projected curve takes one edge');
    return [project(frame, edgeCurve(k, handle))];
  }
  if (kind !== 'face' && kind !== 'body') throw new FeaturePause('an intersection takes a face or a body');
  return sortedByEnds(
    edgesOf(k, k.sectionPlane(handle, kv(frame.origin), kv(frame.normal))).map((c) => project(frame, c)),
  ).map((s) => s.shape);
}

/** A curve's start point in its format direction, as `near` records it. */
export function externalStart(shape: CurveShape): Vec2 {
  return endsOf(shape)[0];
}

/**
 * The curve an `intersect` or `silhouette` row selects: by `index` among the
 * curves sorted by start point, then end point, provided there are still
 * `count` of them and the selected one starts nearest `near` (8.1).
 */
function selected(row: Json, shapes: CurveShape[]): CurveShape {
  if (row.index === undefined) throw new FeaturePause('an intersect or silhouette row carries index, count and near');
  const count = row.count as number;
  if (shapes.length !== count)
    throw new FeaturePause(`the source now yields ${shapes.length} curves, not ${count}: reconnect the external curve`);
  const sorted = sortedByEnds(shapes);
  const index = row.index as number;
  const chosen = sorted[index];
  if (!chosen) throw new FeaturePause('the external curve selects a curve past the last');
  const near = row.near as Vec2;
  const far = (p: Vec2) => Math.hypot(p[0] - near[0], p[1] - near[1]);
  const best = Math.min(...sorted.map((s) => far(s.ends[0])));
  const nearest = sorted.filter((s) => level(far(s.ends[0]), best));
  if (nearest.length !== 1 || nearest[0] !== chosen)
    throw new FeaturePause('the curves of the source changed order: reconnect the external curve');
  return chosen.shape;
}

/** Every external row of a sketch, built in the sketch frame; a row that cannot be built pauses the sketch. */
export function buildExternals(ctx: BuildContext, frame: Frame): ExternalCurve[] {
  const { values } = ctx.ev;
  const out: ExternalCurve[] = [];
  for (const row of ctx.inputs.curves as Json[]) {
    if (row.kind !== 'external') continue;
    const id = row.id as string;
    try {
      const mode = values.literal(row.mode, {
        type: 'choice',
        options: ['project', 'intersect', 'silhouette'],
      }) as string;
      const several = mode !== 'project';
      if (!several && row.index !== undefined)
        throw new FeaturePause('a projected curve carries no index, count or near');
      const shapes = sourceCurves(ctx, row, mode, frame).map((c) => project(frame, c));
      const shape = several ? selected(row, shapes) : (shapes[0] as CurveShape);
      const bounds = values.literal(row.defining, FLAG) === true && values.literal(row.construction, FLAG) !== true;
      out.push({ id, shape, bounds });
    } catch (e) {
      if (e instanceof FeaturePause) throw new FeaturePause(`external curve ${id}: ${e.message}`);
      throw e;
    }
  }
  return out;
}
