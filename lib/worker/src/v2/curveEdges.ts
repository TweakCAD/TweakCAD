/**
 * Kernel edges for stretches of the sketch curves that are neither lines nor
 * circles: ellipses, elliptical arcs and NURBS (which splines, beziers and
 * conics are), and glyph contours (one edge per Bézier segment), built exactly
 * from their solved shapes, and how far a point is from such a stretch.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import type { Curve, CurveShape } from '@tweakcad/format';
import { FeaturePause, add, kv, scale, type Frame, type V3 } from './context';

type P2 = readonly [number, number];

/** A sketch-plane point in the part frame. */
function lift(frame: Frame, p: P2): V3 {
  return add(add(frame.origin, scale(frame.x, p[0])), scale(frame.y, p[1]));
}

/** The angle an ellipse's parameter starts from: 0 at its major end, an elliptical arc's start otherwise. */
function ellipseStart(shape: Extract<CurveShape, { kind: 'ellipse' | 'ellipticalArc' }>): number {
  if (shape.kind === 'ellipse') return 0;
  const [cx, cy] = shape.center;
  const [mx, my] = [shape.majorEnd[0] - cx, shape.majorEnd[1] - cy];
  const major = Math.hypot(mx, my);
  const [ux, uy] = [mx / major, my / major];
  const [dx, dy] = [shape.start[0] - cx, shape.start[1] - cy];
  return Math.atan2((-dx * uy + dy * ux) / shape.minorRadius, (dx * ux + dy * uy) / major);
}

function ellipseStretch(
  k: OcctKernel,
  frame: Frame,
  shape: Extract<CurveShape, { kind: 'ellipse' | 'ellipticalArc' }>,
  lo: number,
  hi: number,
): ShapeHandle {
  const [cx, cy] = shape.center;
  const [mx, my] = [shape.majorEnd[0] - cx, shape.majorEnd[1] - cy];
  const major = Math.hypot(mx, my);
  const minor = shape.minorRadius;
  const start = ellipseStart(shape);
  const u: P2 = [mx / major, my / major];
  const center = kv(lift(frame, shape.center));
  const normal = kv(frame.normal);
  const along = (d: P2) => {
    const p = lift(frame, [cx + d[0], cy + d[1]]);
    const o = lift(frame, shape.center);
    return kv([p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
  };
  if (major >= minor) return k.makeEllipseArc(center, normal, major, minor, start + lo, start + hi, along(u));
  // The kernel's major axis is the longer one: here the format's minor axis, a quarter turn on.
  return k.makeEllipseArc(
    center,
    normal,
    minor,
    major,
    start + lo - Math.PI / 2,
    start + hi - Math.PI / 2,
    along([-u[1], u[0]]),
  );
}

interface NurbsPiece {
  degree: number;
  knots: number[];
  multiplicities: number[];
  poles: number[];
  weights: number[];
}

function pieceOf(k: OcctKernel, edge: ShapeHandle): NurbsPiece {
  const d = k.getNurbsCurveData(edge);
  const count = d.poles.length / 3;
  return {
    degree: d.degree,
    knots: [...d.knots],
    multiplicities: [...d.multiplicities],
    poles: [...d.poles],
    weights: d.weights.length === count ? [...d.weights] : new Array<number>(count).fill(1),
  };
}

/** The stretch `lo..hi` of a kernel B-spline edge whose parameters run `first..last`. */
export function segment(
  k: OcctKernel,
  edge: ShapeHandle,
  first: number,
  last: number,
  lo: number,
  hi: number,
): ShapeHandle {
  const slack = 1e-12 * (last - first);
  let out = edge;
  if (lo > first + slack) out = (k.curveSplit(out, lo) as [ShapeHandle, ShapeHandle])[1];
  if (hi < last - slack) out = (k.curveSplit(out, hi) as [ShapeHandle, ShapeHandle])[0];
  return out;
}

/**
 * Two clamped B-splines joined where the first ends and the second starts, the
 * second's parameters moved by `shift`: one B-spline, exactly both.
 */
function joined(a: NurbsPiece, b: NurbsPiece, shift: number): NurbsPiece {
  const p = a.degree;
  // Scaling a rational piece's weights leaves its curve as it is; match them at the join.
  const ratio = (a.weights[a.weights.length - 1] as number) / (b.weights[0] as number);
  return {
    degree: p,
    knots: [...a.knots, ...b.knots.slice(1).map((t) => t + shift)],
    multiplicities: [...a.multiplicities.slice(0, -1), p, ...b.multiplicities.slice(1)],
    poles: [...a.poles, ...b.poles.slice(3)],
    weights: [...a.weights, ...b.weights.slice(1).map((w) => w * ratio)],
  };
}

function nurbsStretch(
  k: OcctKernel,
  frame: Frame,
  curve: Curve,
  shape: Extract<CurveShape, { kind: 'nurbs' }>,
  lo: number,
  hi: number,
): ShapeHandle {
  const poles = shape.poles.flatMap((q) => lift(frame, q));
  const full = k.makeBSplineEdge(
    poles,
    [...shape.weights],
    [...shape.knots],
    [...shape.multiplicities],
    shape.degree,
    shape.periodic,
  );
  const { tMin, tMax } = curve;
  const period = tMax - tMin;
  if (curve.closed && hi - lo >= period * (1 - 1e-12)) return full;
  if (hi <= tMax + 1e-12 * period) return segment(k, full, tMin, tMax, lo, Math.min(hi, tMax));
  // A stretch over the start of a closed curve: its end, then its beginning.
  const tail = pieceOf(k, segment(k, full, tMin, tMax, lo, tMax));
  const head = pieceOf(k, segment(k, full, tMin, tMax, tMin, hi - period));
  const one = joined(tail, head, period);
  return k.makeBSplineEdge(one.poles, one.weights, one.knots, one.multiplicities, one.degree, false);
}

/** One Bézier segment's part of a glyph contour stretch: its number on the contour, its edge and its parameters on the contour. */
export interface ContourPiece {
  segment: number;
  edge: ShapeHandle;
  lo: number;
  hi: number;
}

/**
 * The kernel edges of the stretch `lo..hi` of a glyph contour, one per Bézier
 * segment it covers, in order along the contour: a line segment as a line,
 * a quadratic or cubic as the B-spline it is, each cut to the stretch. The
 * contour's parameter runs from `i` to `i + 1` over segment `i`; a stretch
 * over the contour's start runs past its last parameter.
 */
export function contourEdges(
  k: OcctKernel,
  frame: Frame,
  shape: Extract<CurveShape, { kind: 'contour' }>,
  lo: number,
  hi: number,
): ContourPiece[] {
  const count = shape.segments.length;
  const slack = 1e-12 * count;
  const out: ContourPiece[] = [];
  let t = lo;
  while (t < hi - slack) {
    const base = Math.floor(t + slack);
    const end = Math.min(hi, base + 1);
    const index = ((base % count) + count) % count;
    const control = shape.segments[index] as readonly P2[];
    const [u0, u1] = [Math.max(0, t - base), Math.min(1, end - base)];
    const at = (u: number): P2 => {
      let row = control;
      while (row.length > 1) {
        const current = row;
        row = current.slice(1).map((q, i): P2 => {
          const a = current[i] as P2;
          return [a[0] + (q[0] - a[0]) * u, a[1] + (q[1] - a[1]) * u];
        });
      }
      return row[0] as P2;
    };
    let edge: ShapeHandle;
    if (control.length === 2) edge = k.makeLineEdge(kv(lift(frame, at(u0))), kv(lift(frame, at(u1))));
    else {
      const degree = control.length - 1;
      const full = k.makeBSplineEdge(
        control.flatMap((q) => lift(frame, q)),
        control.map(() => 1),
        [0, 1],
        [degree + 1, degree + 1],
        degree,
        false,
      );
      edge = u0 > 0 || u1 < 1 ? segment(k, full, 0, 1, u0, u1) : full;
    }
    out.push({ segment: index, edge, lo: index + u0, hi: index + u1 });
    t = end;
  }
  return out;
}

/** The kernel edge of the stretch `lo..hi` of a curve, running along the curve's direction. */
export function stretchEdge(
  k: OcctKernel,
  frame: Frame,
  shape: CurveShape,
  curve: Curve,
  lo: number,
  hi: number,
): ShapeHandle {
  switch (shape.kind) {
    case 'ellipse':
    case 'ellipticalArc':
      return ellipseStretch(k, frame, shape, lo, hi);
    case 'nurbs':
      return nurbsStretch(k, frame, curve, shape, lo, hi);
    default:
      throw new FeaturePause(`profiles bounded by ${shape.kind} curves are not built yet`);
  }
}

/** Whether the parameter `t` lies on the stretch `lo..hi`, a closed curve's parameters wrapping. */
function onStretch(curve: Curve, t: number, lo: number, hi: number): boolean {
  const slack = 1e-9 * (curve.tMax - curve.tMin);
  if (!curve.closed) return t >= lo - slack && t <= hi + slack;
  const along = (((t - lo) % curve.period) + curve.period) % curve.period;
  return along <= hi - lo + slack || along >= curve.period - slack;
}

/** The parameter where `f` peaks between `a` and `b`, by golden section. */
function peak(f: (t: number) => number, a: number, b: number): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let [x, y] = [b - ratio * (b - a), a + ratio * (b - a)];
  let [fx, fy] = [f(x), f(y)];
  for (let i = 0; i < 80 && b - a > 1e-14 * (1 + Math.abs(b)); i++) {
    if (fx > fy) {
      b = y;
      y = x;
      fy = fx;
      x = b - ratio * (b - a);
      fx = f(x);
    } else {
      a = x;
      x = y;
      fx = fy;
      y = a + ratio * (b - a);
      fy = f(y);
    }
  }
  return (a + b) / 2;
}

/** How far a point is from the stretch `lo..hi` of a curve, and how far the stretch reaches along a direction. */
export function stretchMeasures(
  curve: Curve,
  lo: number,
  hi: number,
): { distance: (p: P2) => number; span: (along: P2) => readonly [number, number] } {
  const ends = [curve.point(lo), curve.point(hi)];
  const far = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  return {
    distance: (p) => {
      const hits = curve.closest(p).filter((h) => onStretch(curve, h.t, lo, hi));
      if (hits.length > 0) return Math.min(...hits.map((h) => h.distance));
      return Math.min(...ends.map((q) => far(p, q)));
    },
    span: (along) => {
      const f = (t: number) => {
        const q = curve.point(t);
        return q[0] * along[0] + q[1] * along[1];
      };
      const steps = 64;
      const ts = Array.from({ length: steps + 1 }, (_, i) => lo + ((hi - lo) * i) / steps);
      const fs = ts.map(f);
      let [min, max] = [Math.min(...fs), Math.max(...fs)];
      for (let i = 1; i < steps; i++) {
        const [a, b, here] = [ts[i - 1] as number, ts[i + 1] as number, fs[i] as number];
        if (here >= (fs[i - 1] as number) && here >= (fs[i + 1] as number)) max = Math.max(max, f(peak(f, a, b)));
        if (here <= (fs[i - 1] as number) && here <= (fs[i + 1] as number))
          min = Math.min(min, f(peak((t) => -f(t), a, b)));
      }
      return [min, max];
    },
  };
}
