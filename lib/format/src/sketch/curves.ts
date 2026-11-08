import { FormatError } from '../collections';
import type { CurveShape, Vec2 } from './types';

export const TAU = 2 * Math.PI;

export function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`index ${index} out of range`);
  return value;
}

export function mod(value: number, modulus: number): number {
  const r = value % modulus;
  return r < 0 ? r + modulus : r;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: readonly Vec2[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

export function boundsOverlap(a: Bounds, b: Bounds, margin: number): boolean {
  return (
    a.minX <= b.maxX + margin && b.minX <= a.maxX + margin && a.minY <= b.maxY + margin && b.minY <= a.maxY + margin
  );
}

export type CurveForm =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circular'; center: Vec2; radius: number; start: number; sweep: number }
  | { kind: 'general' };

export interface Polyline {
  params: readonly number[];
  points: readonly Vec2[];
  /** Upper estimate of how far the curve strays from a chord. */
  deviation: number;
}

// Five-point Gauss-Legendre rule on [-1, 1].
const GAUSS: readonly (readonly [number, number])[] = [
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.47862867049936647],
  [-0.5384693101056831, 0.47862867049936647],
  [0.906179845938664, 0.23692688505618908],
  [-0.906179845938664, 0.23692688505618908],
];

function gauss(f: (t: number) => number, a: number, b: number): number {
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  let sum = 0;
  for (const [x, w] of GAUSS) sum += w * f(mid + half * x);
  return sum * half;
}

interface CurveSpec {
  form: CurveForm;
  closed: boolean;
  /** Ascending parameters from the curve's start to its end; smooth between neighbours. */
  panels: readonly number[];
  /** Chords per panel when flattening. */
  steps: number;
  /** The constant speed of a line or circular curve. */
  speed?: number;
  point: (t: number) => Vec2;
  derivative: (t: number) => Vec2;
}

/** A parametric curve running in its format direction, parameter increasing. */
export class Curve {
  readonly form: CurveForm;
  readonly closed: boolean;
  readonly tMin: number;
  readonly tMax: number;
  readonly length: number;
  readonly bounds: Bounds;
  private readonly spec: CurveSpec;
  private readonly cumulative: readonly number[];
  private coarse: Polyline | undefined;

  constructor(spec: CurveSpec) {
    this.spec = spec;
    this.form = spec.form;
    this.closed = spec.closed;
    this.tMin = at(spec.panels, 0);
    this.tMax = at(spec.panels, spec.panels.length - 1);
    const cumulative = [0];
    for (let i = 1; i < spec.panels.length; i++) {
      const a = at(spec.panels, i - 1);
      const b = at(spec.panels, i);
      cumulative.push(at(cumulative, i - 1) + this.panelLength(a, b));
    }
    this.cumulative = cumulative;
    this.length = at(cumulative, cumulative.length - 1);
    const polyline = this.polyline();
    const b = boundsOf(polyline.points);
    const d = polyline.deviation;
    this.bounds = { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
  }

  private panelLength(a: number, b: number): number {
    if (this.spec.speed !== undefined) return (b - a) * this.spec.speed;
    return gauss(
      (t) => {
        const [dx, dy] = this.spec.derivative(t);
        return Math.hypot(dx, dy);
      },
      a,
      b,
    );
  }

  get period(): number {
    return this.tMax - this.tMin;
  }

  /** The parameter inside the curve's domain; a closed curve's end wraps to its start. */
  wrap(t: number): number {
    if (this.closed) return this.tMin + mod(t - this.tMin, this.period);
    return Math.min(this.tMax, Math.max(this.tMin, t));
  }

  point(t: number): Vec2 {
    return this.spec.point(this.wrap(t));
  }

  derivative(t: number): Vec2 {
    return this.spec.derivative(this.wrap(t));
  }

  /** Unit direction of travel leaving `t` towards increasing (`sign` 1) or decreasing (-1) parameter. */
  direction(t: number, sign: 1 | -1): Vec2 {
    let x: number;
    let y: number;
    if (this.form.kind === 'general') {
      const h = 1e-6 * this.period * sign;
      const p = this.point(t);
      const q = this.point(this.closed ? t + h : Math.min(this.tMax, Math.max(this.tMin, t + h)));
      x = q[0] - p[0];
      y = q[1] - p[1];
      const n = Math.hypot(x, y);
      return [x / n, y / n];
    }
    [x, y] = this.derivative(t);
    const n = Math.hypot(x, y) * sign;
    return [x / n, y / n];
  }

  /** Unit tangent at `t` in the curve's direction, the one leaving `t` except at the end of an open curve. */
  tangent(t: number): Vec2 {
    if (this.closed || t < this.tMax) return this.direction(t, 1);
    const [x, y] = this.direction(t, -1);
    return [-x, -y];
  }

  /** Arc length from the curve's start to `t`, inside the domain. */
  lengthTo(t: number): number {
    const u = this.wrap(t);
    if (this.spec.speed !== undefined) return (u - this.tMin) * this.spec.speed;
    const i = this.panelIndex(u);
    return at(this.cumulative, i) + this.panelLength(at(this.spec.panels, i), u);
  }

  private panelIndex(u: number): number {
    const { panels } = this.spec;
    let lo = 0;
    let hi = panels.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (at(panels, mid) <= u) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Arc length on the unwrapped span `t0 <= t1`. */
  spanLength(t0: number, t1: number): number {
    if (!this.closed) return this.lengthTo(t1) - this.lengthTo(t0);
    const laps = Math.floor((t1 - this.tMin) / this.period) - Math.floor((t0 - this.tMin) / this.period);
    return laps * this.length + this.lengthTo(t1) - this.lengthTo(t0);
  }

  /** The parameter at arc length `s` from the start, inside the domain. */
  paramAt(s: number): number {
    const target = this.closed ? mod(s, this.length) : Math.min(this.length, Math.max(0, s));
    if (this.spec.speed !== undefined) return this.tMin + target / this.spec.speed;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at(this.cumulative, mid) <= target) lo = mid;
      else hi = mid;
    }
    const first = at(this.spec.panels, lo);
    const base = at(this.cumulative, lo);
    let a = first;
    let b = at(this.spec.panels, hi);
    for (let i = 0; i < 50; i++) {
      const mid = (a + b) / 2;
      if (base + this.panelLength(first, mid) <= target) a = mid;
      else b = mid;
    }
    return (a + b) / 2;
  }

  /** The parameters to integrate or flatten over on the unwrapped span `t0 <= t1`. */
  private breaks(t0: number, t1: number): number[] {
    const out = [t0];
    const firstLap = this.closed ? Math.floor((t0 - this.tMin) / this.period) : 0;
    const lastLap = this.closed ? Math.floor((t1 - this.tMin) / this.period) : 0;
    for (let lap = firstLap; lap <= lastLap; lap++) {
      const shift = this.closed ? lap * this.period : 0;
      for (const p of this.spec.panels) {
        const t = p + shift;
        if (t > t0 && t < t1 && t > at(out, out.length - 1)) out.push(t);
      }
    }
    out.push(t1);
    return out;
  }

  /** Half the integral of x dy - y dx about `origin` over the unwrapped span `t0 <= t1`. */
  areaTerm(t0: number, t1: number, origin: Vec2): number {
    if (this.form.kind === 'line') {
      const a = this.point(t0);
      const b = this.point(t1);
      return ((a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])) / 2;
    }
    const f = (t: number): number => {
      const [x, y] = this.point(t);
      const [dx, dy] = this.derivative(t);
      return (x - origin[0]) * dy - (y - origin[1]) * dx;
    };
    const breaks = this.breaks(t0, t1);
    let sum = 0;
    for (let i = 1; i < breaks.length; i++) sum += gauss(f, at(breaks, i - 1), at(breaks, i));
    return sum / 2;
  }

  /** Chords over the unwrapped span `t0 <= t1`, `factor` times finer than the default. */
  flatten(t0: number, t1: number, factor = 1): Vec2[] {
    const out: Vec2[] = [this.point(t0)];
    const steps = this.form.kind === 'line' ? 1 : this.spec.steps * factor;
    const breaks = this.breaks(t0, t1);
    for (let i = 1; i < breaks.length; i++) {
      const a = at(breaks, i - 1);
      const b = at(breaks, i);
      for (let k = 1; k <= steps; k++) out.push(this.point(a + ((b - a) * k) / steps));
    }
    return out;
  }

  /** The default flattening of the whole curve with the parameter of every point. */
  polyline(): Polyline {
    if (this.coarse) return this.coarse;
    const steps = this.form.kind === 'line' ? 1 : this.spec.steps;
    const { panels } = this.spec;
    const params: number[] = [this.tMin];
    for (let i = 1; i < panels.length; i++) {
      const a = at(panels, i - 1);
      const b = at(panels, i);
      for (let k = 1; k <= steps; k++) params.push(a + ((b - a) * k) / steps);
    }
    const points = params.map((t) => this.spec.point(Math.min(t, this.tMax)));
    let deviation = 0;
    if (this.form.kind !== 'line') {
      for (let i = 1; i < points.length; i++) {
        const p = at(points, i - 1);
        const q = at(points, i);
        const mid = this.spec.point((at(params, i - 1) + at(params, i)) / 2);
        const d = distance(mid, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        if (d > deviation) deviation = d;
      }
      deviation *= 2;
    }
    this.coarse = { params, points, deviation };
    return this.coarse;
  }

  /** The nearest points of the curve to `p`: one entry per equally near local minimum. */
  closest(p: Vec2): { t: number; distance: number }[] {
    const { form } = this;
    if (form.kind === 'line') {
      const dx = form.b[0] - form.a[0];
      const dy = form.b[1] - form.a[1];
      const t = ((p[0] - form.a[0]) * dx + (p[1] - form.a[1]) * dy) / (dx * dx + dy * dy);
      const u = Math.min(1, Math.max(0, t));
      return [{ t: u, distance: distance(p, this.spec.point(u)) }];
    }
    if (form.kind === 'circular') {
      const theta = Math.atan2(p[1] - form.center[1], p[0] - form.center[0]);
      const t = mod(theta - form.start, TAU);
      if (t <= form.sweep) {
        return [{ t, distance: Math.abs(distance(p, form.center) - form.radius) }];
      }
      return nearestOnly([0, form.sweep].map((u) => ({ t: u, distance: distance(p, this.spec.point(u)) })));
    }
    const { params, points } = this.polyline();
    const n = points.length;
    const d = points.map((q) => distance(p, q));
    const found: { t: number; distance: number }[] = [];
    const count = this.closed ? n - 1 : n;
    for (let i = 0; i < count; i++) {
      const here = at(d, i);
      const before = i > 0 ? i - 1 : this.closed ? n - 2 : -1;
      const after = i < n - 1 ? i + 1 : -1;
      if (before >= 0 && at(d, before) < here) continue;
      if (after >= 0 && at(d, after) < here) continue;
      let lo = i > 0 ? at(params, i - 1) : this.tMin;
      if (i === 0 && this.closed) lo = this.tMin - (this.tMax - at(params, n - 2));
      const hi = i < n - 1 ? at(params, i + 1) : this.tMax;
      found.push(this.golden(p, lo, hi));
    }
    return nearestOnly(found);
  }

  private golden(p: Vec2, lo: number, hi: number): { t: number; distance: number } {
    const ratio = (Math.sqrt(5) - 1) / 2;
    const f = (t: number): number => distance(p, this.point(t));
    let a = lo;
    let b = hi;
    let c = b - ratio * (b - a);
    let d = a + ratio * (b - a);
    let fc = f(c);
    let fd = f(d);
    for (let i = 0; i < 60 && b - a > 1e-12 * (1 + Math.abs(b)); i++) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - ratio * (b - a);
        fc = f(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + ratio * (b - a);
        fd = f(d);
      }
    }
    return [(a + b) / 2, lo, hi]
      .map((u) => ({ t: this.wrap(u), distance: f(u) }))
      .reduce((x, y) => (y.distance < x.distance ? y : x));
  }
}

function nearestOnly(found: { t: number; distance: number }[]): { t: number; distance: number }[] {
  const best = Math.min(...found.map((f) => f.distance));
  return found.filter((f) => f.distance <= best * (1 + 1e-9) + 1e-12);
}

function lineCurve(start: Vec2, end: Vec2): Curve {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return new Curve({
    form: { kind: 'line', a: start, b: end },
    closed: false,
    panels: [0, 1],
    steps: 1,
    speed: Math.hypot(dx, dy),
    point: (t) => [start[0] + t * dx, start[1] + t * dy],
    derivative: () => [dx, dy],
  });
}

function evenPanels(sweep: number): number[] {
  const count = Math.max(1, Math.ceil(sweep / (Math.PI / 8)));
  return Array.from({ length: count + 1 }, (_, i) => (sweep * i) / count);
}

function circularCurve(center: Vec2, radius: number, start: number, sweep: number, closed: boolean): Curve {
  return new Curve({
    form: { kind: 'circular', center, radius, start, sweep },
    closed,
    panels: evenPanels(sweep),
    steps: 4,
    speed: radius,
    point: (t) => [center[0] + radius * Math.cos(start + t), center[1] + radius * Math.sin(start + t)],
    derivative: (t) => [-radius * Math.sin(start + t), radius * Math.cos(start + t)],
  });
}

interface EllipseFrame {
  center: Vec2;
  ux: number;
  uy: number;
  major: number;
  minor: number;
}

function ellipseFrame(center: Vec2, majorEnd: Vec2, minor: number): EllipseFrame {
  const dx = majorEnd[0] - center[0];
  const dy = majorEnd[1] - center[1];
  const major = Math.hypot(dx, dy);
  return { center, ux: dx / major, uy: dy / major, major, minor };
}

function ellipticalCurve(frame: EllipseFrame, start: number, sweep: number, closed: boolean): Curve {
  const { center, ux, uy, major, minor } = frame;
  return new Curve({
    form: { kind: 'general' },
    closed,
    panels: evenPanels(sweep),
    steps: 4,
    point: (t) => {
      const c = major * Math.cos(start + t);
      const s = minor * Math.sin(start + t);
      return [center[0] + c * ux - s * uy, center[1] + c * uy + s * ux];
    },
    derivative: (t) => {
      const c = -major * Math.sin(start + t);
      const s = minor * Math.cos(start + t);
      return [c * ux - s * uy, c * uy + s * ux];
    },
  });
}

function ellipseAngle(frame: EllipseFrame, p: Vec2): number {
  const dx = p[0] - frame.center[0];
  const dy = p[1] - frame.center[1];
  const u = dx * frame.ux + dy * frame.uy;
  const v = -dx * frame.uy + dy * frame.ux;
  return Math.atan2(v / frame.minor, u / frame.major);
}

function nurbsCurve(shape: Extract<CurveShape, { kind: 'nurbs' }>, closedEnds: boolean): Curve {
  const { degree: p, poles, weights, knots, multiplicities, periodic } = shape;
  if (poles.length !== weights.length || knots.length !== multiplicities.length) {
    throw new FormatError('a nurbs needs one weight per pole and one multiplicity per knot');
  }
  const flat: number[] = [];
  const counted = periodic ? knots.length - 1 : knots.length;
  for (let i = 0; i < counted; i++) {
    for (let m = 0; m < at(multiplicities, i); m++) flat.push(at(knots, i));
  }
  const n = poles.length;
  if (flat.length !== (periodic ? n : n + p + 1)) {
    throw new FormatError('nurbs knots do not fit its poles');
  }
  const first = at(knots, 0);
  const span = at(knots, knots.length - 1) - first;
  const knot = periodic
    ? (j: number): number => at(flat, mod(j, n)) + Math.floor(j / n) * span
    : (j: number): number => flat[j] as number;
  const tMin = periodic ? first : at(flat, p);
  const tMax = periodic ? first + span : at(flat, n);
  const firstSpan = periodic ? at(multiplicities, 0) - 1 : p;
  const poleShift = periodic ? p - firstSpan : 0;
  const lastSpan = periodic ? n + at(multiplicities, 0) - 1 : n - 1;
  const findSpan = (u: number): number => {
    let lo = firstSpan;
    let hi = lastSpan;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (knot(mid) <= u && knot(mid) < tMax) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Region detection evaluates curves millions of times: de Boor runs in place on these.
  const homogeneous = Float64Array.from(
    poles.flatMap((pole, i) => [pole[0] * at(weights, i), pole[1] * at(weights, i), at(weights, i)]),
  );
  const dx = new Float64Array(p + 1);
  const dy = new Float64Array(p + 1);
  const dw = new Float64Array(p + 1);
  const point = (u: number): Vec2 => {
    const f = findSpan(u);
    for (let j = 0; j <= p; j++) {
      const index = 3 * (periodic ? mod(f - p + j + poleShift, n) : f - p + j);
      dx[j] = homogeneous[index] as number;
      dy[j] = homogeneous[index + 1] as number;
      dw[j] = homogeneous[index + 2] as number;
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const lo = knot(f - p + j);
        const hi = knot(f + 1 + j - r);
        const a = hi > lo ? (u - lo) / (hi - lo) : 0;
        dx[j] = (1 - a) * (dx[j - 1] as number) + a * (dx[j] as number);
        dy[j] = (1 - a) * (dy[j - 1] as number) + a * (dy[j] as number);
        dw[j] = (1 - a) * (dw[j - 1] as number) + a * (dw[j] as number);
      }
    }
    const w = dw[p] as number;
    return [(dx[p] as number) / w, (dy[p] as number) / w];
  };
  const closed = periodic || closedEnds;
  const h = 1e-6 * (tMax - tMin);
  const inDomain = (t: number): number =>
    closed ? tMin + mod(t - tMin, tMax - tMin) : Math.min(tMax, Math.max(tMin, t));
  const derivative = (u: number): Vec2 => {
    const a = closed ? u - h : Math.max(tMin, u - h);
    const b = closed ? u + h : Math.min(tMax, u + h);
    const pa = point(inDomain(a));
    const pb = point(inDomain(b));
    return [(pb[0] - pa[0]) / (b - a), (pb[1] - pa[1]) / (b - a)];
  };
  // Two panels a span; four for a rational curve, whose integrands vary more within one.
  const parts = weights.every((w) => w === weights[0]) ? 2 : 4;
  const panels: number[] = [];
  for (const k of knots) {
    if (k < tMin || k > tMax) continue;
    const previous = panels[panels.length - 1];
    if (previous !== undefined) for (let i = 1; i < parts; i++) panels.push(previous + ((k - previous) * i) / parts);
    panels.push(k);
  }
  return new Curve({ form: { kind: 'general' }, closed, panels, steps: 8 / (parts / 2), point, derivative });
}

function bezierPoint(control: readonly Vec2[], u: number): Vec2 {
  let row = control;
  while (row.length > 1) {
    const current = row;
    row = current.slice(1).map((q, i): Vec2 => {
      const a = at(current, i);
      return [a[0] + (q[0] - a[0]) * u, a[1] + (q[1] - a[1]) * u];
    });
  }
  return at(row, 0);
}

function bezierDerivative(control: readonly Vec2[], u: number): Vec2 {
  const degree = control.length - 1;
  const hodograph = control.slice(1).map((q, i): Vec2 => {
    const a = at(control, i);
    return [(q[0] - a[0]) * degree, (q[1] - a[1]) * degree];
  });
  return bezierPoint(hodograph, u);
}

function contourCurve(segments: readonly (readonly Vec2[])[]): Curve {
  const count = segments.length;
  const locate = (t: number): { segment: readonly Vec2[]; u: number } => {
    const i = Math.min(count - 1, Math.max(0, Math.floor(t)));
    return { segment: at(segments, i), u: t - i };
  };
  return new Curve({
    form: { kind: 'general' },
    closed: true,
    panels: Array.from({ length: count + 1 }, (_, i) => i),
    steps: 8,
    point: (t) => {
      const { segment, u } = locate(t);
      return bezierPoint(segment, u);
    },
    derivative: (t) => {
      const { segment, u } = locate(t);
      return bezierDerivative(segment, u);
    },
  });
}

/**
 * Builds the curve of a solved shape; null for one with no extent. `closedEnds`
 * says its two ends coincide, which closes it: an arc then runs the whole way
 * round from its start.
 */
export function prepareCurve(shape: CurveShape, closedEnds: boolean): Curve | null {
  switch (shape.kind) {
    case 'line':
      return distance(shape.start, shape.end) > 0 ? lineCurve(shape.start, shape.end) : null;
    case 'circle':
      return shape.radius > 0 ? circularCurve(shape.center, shape.radius, 0, TAU, true) : null;
    case 'arc': {
      const radius = distance(shape.center, shape.start);
      const a = Math.atan2(shape.start[1] - shape.center[1], shape.start[0] - shape.center[0]);
      const b = Math.atan2(shape.end[1] - shape.center[1], shape.end[0] - shape.center[0]);
      if (!(radius > 0)) return null;
      if (closedEnds) return circularCurve(shape.center, radius, a, TAU, true);
      const sweep = mod(b - a, TAU);
      return sweep > 0 ? circularCurve(shape.center, radius, a, sweep, false) : null;
    }
    case 'ellipse': {
      if (!(shape.minorRadius > 0) || distance(shape.center, shape.majorEnd) === 0) return null;
      const frame = ellipseFrame(shape.center, shape.majorEnd, shape.minorRadius);
      return ellipticalCurve(frame, 0, TAU, true);
    }
    case 'ellipticalArc': {
      if (!(shape.minorRadius > 0) || distance(shape.center, shape.majorEnd) === 0) return null;
      const frame = ellipseFrame(shape.center, shape.majorEnd, shape.minorRadius);
      const a = ellipseAngle(frame, shape.start);
      if (closedEnds) return ellipticalCurve(frame, a, TAU, true);
      const sweep = mod(ellipseAngle(frame, shape.end) - a, TAU);
      return sweep > 0 ? ellipticalCurve(frame, a, sweep, false) : null;
    }
    case 'nurbs':
      return nurbsCurve(shape, closedEnds);
    case 'contour':
      return shape.segments.length > 0 ? contourCurve(shape.segments) : null;
  }
}
