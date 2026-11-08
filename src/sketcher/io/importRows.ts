/**
 * The rows a file import adds to a sketch (8.1). Curve ends that meet share
 * one sketch point, as coincidence is a shared point; centres, axis ends and
 * inner control points are points of their own curve.
 */
import type { Change } from '../change';
import type { Json, P2, RowMaker } from '../rows';

/**
 * How near two curve ends are to share a point, in mm. Coordinates written by
 * other programs are rounded to a few decimals, so ends meant to meet can
 * differ in the last digit; 0.1 µm absorbs that and is far below any
 * tolerance that matters.
 */
export const MERGE_EPSILON_MM = 1e-4;

/** What importing a file adds to a sketch. */
export interface SketchImport {
  /** The rows to add, as one edit; no constraints. */
  change: Change;
  /** The entity or element kinds the file holds that import does not read, each once. */
  skipped: string[];
}

/** The B-spline of a `nurbs` row: distinct increasing knots with their multiplicities. */
export interface NurbsData {
  degree: number;
  poles: P2[];
  weights: number[];
  knots: number[];
  multiplicities: number[];
}

const dist = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The text of a number for a value expression. */
function numberText(n: number): string {
  return String(n === 0 ? 0 : n);
}

export class ImportRows {
  readonly points: Json[] = [];
  readonly curves: Json[] = [];
  private readonly skippedKinds = new Set<string>();
  private readonly ends = new Map<string, { id: string; at: P2 }[]>();

  constructor(readonly make: RowMaker) {}

  skip(kind: string): void {
    this.skippedKinds.add(kind);
  }

  /** A point of its own. */
  free(at: P2): string {
    const p = this.make.point(at[0], at[1]);
    this.points.push(p);
    return p.id as string;
  }

  /** The point at a curve end: an end already within MERGE_EPSILON_MM of `at`, or a new one. */
  end(at: P2): string {
    const cell = (v: number) => Math.floor(v / MERGE_EPSILON_MM);
    const [cx, cy] = [cell(at[0]), cell(at[1])];
    let best: { id: string; d: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const e of this.ends.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = dist(e.at, at);
          if (d <= MERGE_EPSILON_MM && (!best || d < best.d)) best = { id: e.id, d };
        }
      }
    }
    if (best) return best.id;
    const id = this.free(at);
    const key = `${cx},${cy}`;
    this.ends.set(key, [...(this.ends.get(key) ?? []), { id, at }]);
    return id;
  }

  private curve(kind: string, fields: Json): void {
    this.curves.push({
      id: this.make.id('crv'),
      kind,
      construction: this.make.flag(false),
      origin: { drawn: {} },
      ...fields,
    });
  }

  line(a: P2, b: P2): void {
    if (dist(a, b) <= MERGE_EPSILON_MM) return;
    this.curves.push(this.make.line(this.end(a), this.end(b)));
  }

  circle(center: P2, radius: number): void {
    if (!(radius > 0)) return;
    this.curves.push(this.make.circle(this.free(center), radius));
  }

  /** Counter-clockwise from `start` to `end` about `center`. */
  arc(center: P2, start: P2, end: P2): void {
    if (!(dist(center, start) > 0) || dist(start, end) <= MERGE_EPSILON_MM) return;
    const c = this.free(center);
    this.curves.push(this.make.arc(c, this.end(start), this.end(end)));
  }

  ellipse(center: P2, majorEnd: P2, minorRadius: number): void {
    const axes = majorAxis(center, majorEnd, minorRadius);
    if (!axes) return;
    this.curve('ellipse', {
      center: this.free(center),
      majorEnd: this.free(axes.majorEnd),
      minorRadius: axes.minorRadius,
    });
  }

  /** Counter-clockwise by eccentric angle from `start` to `end`. */
  ellipticalArc(center: P2, majorEnd: P2, minorRadius: number, start: P2, end: P2): void {
    const axes = majorAxis(center, majorEnd, minorRadius);
    if (!axes || dist(start, end) <= MERGE_EPSILON_MM) return;
    const [c, m] = [this.free(center), this.free(axes.majorEnd)];
    this.curve('ellipticalArc', {
      center: c,
      majorEnd: m,
      minorRadius: axes.minorRadius,
      start: this.end(start),
      end: this.end(end),
    });
  }

  bezier(start: P2, c1: P2, c2: P2, end: P2): void {
    if ([c1, c2, end].every((p) => dist(p, start) <= MERGE_EPSILON_MM)) return;
    const s = this.end(start);
    const [a, b] = [this.free(c1), this.free(c2)];
    this.curve('bezier', { start: s, c1: a, c2: b, end: this.end(end) });
  }

  /** The rational quadratic from `start` to `end` with end tangents meeting at `apex` (8.1). */
  conic(start: P2, apex: P2, end: P2, rho: number): void {
    if (!(rho > 0 && rho < 1) || [apex, end].every((p) => dist(p, start) <= MERGE_EPSILON_MM)) return;
    const s = this.end(start);
    const a = this.free(apex);
    this.curve('conic', { start: s, end: this.end(end), apex: a, rho: this.make.value(numberText(rho)) });
  }

  /** The clamped cubic through the points in order. */
  spline(through: P2[]): void {
    if (through.length < 2) return;
    const ids = through.map((p, i) => (i === 0 || i === through.length - 1 ? this.end(p) : this.free(p)));
    if (new Set(ids).size < 2) return;
    this.curve('spline', { through: ids });
  }

  /**
   * A non-periodic B-spline. A clamped one ends at its first and last poles,
   * which share points with the curve ends there; the poles of an unclamped one
   * are points of its own.
   */
  nurbs(n: NurbsData): void {
    const last = n.poles.length - 1;
    const clamped =
      n.multiplicities[0] === n.degree + 1 && n.multiplicities[n.multiplicities.length - 1] === n.degree + 1;
    const poles = n.poles.map((p, i) => (clamped && (i === 0 || i === last) ? this.end(p) : this.free(p)));
    this.curve('nurbs', {
      degree: this.make.value(String(n.degree)),
      poles,
      weights: n.weights.map((w) => this.make.value(numberText(w))),
      knots: n.knots.map((k) => this.make.value(numberText(k))),
      multiplicities: [...n.multiplicities],
      periodic: this.make.flag(false),
    });
  }

  result(label: string): SketchImport {
    return { change: { label, add: { points: this.points, curves: this.curves } }, skipped: [...this.skippedKinds] };
  }
}

/**
 * The longer axis of an ellipse as its major axis: when `minorRadius` exceeds
 * |majorEnd − center|, the axis a quarter turn counter-clockwise becomes the
 * major one. The curve and its direction stay the same.
 */
function majorAxis(center: P2, majorEnd: P2, minorRadius: number): { majorEnd: P2; minorRadius: number } | null {
  const [dx, dy] = [majorEnd[0] - center[0], majorEnd[1] - center[1]];
  const major = Math.hypot(dx, dy);
  if (!(major > 0) || !(minorRadius > 0)) return null;
  if (minorRadius <= major) return { majorEnd, minorRadius };
  const s = minorRadius / major;
  return { majorEnd: [center[0] - dy * s, center[1] + dx * s], minorRadius: major };
}

/** A B-spline from a flat knot vector, or null when the knots do not fit. */
export function nurbsFromFlat(degree: number, poles: P2[], weights: number[], flat: number[]): NurbsData | null {
  if (flat.length !== poles.length + degree + 1) return null;
  const span = Math.abs((flat[flat.length - 1] as number) - (flat[0] as number));
  const tolerance = span * 1e-10;
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (const k of flat) {
    const prev = knots[knots.length - 1];
    if (prev !== undefined && Math.abs(k - prev) <= tolerance)
      multiplicities.push((multiplicities.pop() as number) + 1);
    else if (prev !== undefined && k < prev) return null;
    else {
      knots.push(k);
      multiplicities.push(1);
    }
  }
  if (knots.length < 2 || multiplicities.some((m) => m > degree + 1)) return null;
  return { degree, poles, weights, knots, multiplicities };
}

/** The clamped B-spline with evenly spaced knots over `poles`. */
export function clampedUniform(degree: number, poles: P2[], weights: number[]): NurbsData {
  const d = Math.max(1, Math.min(degree, poles.length - 1));
  const spans = poles.length - d;
  const knots = Array.from({ length: spans + 1 }, (_, i) => i / spans);
  const multiplicities = knots.map((_, i) => (i === 0 || i === spans ? d + 1 : 1));
  return { degree: d, poles, weights, knots, multiplicities };
}

/**
 * Adds a B-spline as the simplest row that is exactly it: a line, a cubic
 * `bezier`, a `conic` (a single-span quadratic with equal end weights), or
 * else a `nurbs` row.
 */
export function addBSpline(rows: ImportRows, n: NurbsData): void {
  const single = n.knots.length === 2 && n.multiplicities.every((m) => m === n.degree + 1);
  const w = n.weights;
  const [p0, p1, p2, p3] = n.poles as [P2, P2, P2, P2];
  if (single && n.degree === 1) rows.line(p0, p1);
  else if (single && n.degree === 3 && w.every((x) => Math.abs(x - (w[0] as number)) <= 1e-12 * (w[0] as number)))
    rows.bezier(p0, p1, p2, p3);
  else if (single && n.degree === 2 && Math.abs((w[0] as number) - (w[2] as number)) <= 1e-12 * (w[0] as number)) {
    const middle = (w[1] as number) / (w[0] as number);
    rows.conic(p0, p1, p2, middle / (1 + middle));
  } else rows.nurbs(n);
}
