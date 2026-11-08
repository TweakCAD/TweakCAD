/**
 * The NURBS a spline, bezier or conic row stands for (8.1), so every reader
 * detects regions on, and builds edges from, the same curve.
 */
import { FormatError } from '../collections';
import { at, distance } from './curves';
import type { CurveShape, Vec2 } from './types';

type Nurbs = Extract<CurveShape, { kind: 'nurbs' }>;

/** The cubic Bezier from `start` to `end` with inner control points `c1`, `c2`. */
export function bezierShape(start: Vec2, c1: Vec2, c2: Vec2, end: Vec2): Nurbs {
  return {
    kind: 'nurbs',
    degree: 3,
    poles: [start, c1, c2, end],
    weights: [1, 1, 1, 1],
    knots: [0, 1],
    multiplicities: [4, 4],
    periodic: false,
  };
}

/**
 * The conic from `start` to `end` whose end tangents meet at `apex`, as a
 * rational quadratic: the middle weight is rho / (1 - rho), so the curve
 * crosses the line from the chord's midpoint to `apex` at the fraction `rho`
 * of the way. `rho` lies strictly between 0 and 1: below 1/2 an ellipse, at
 * 1/2 a parabola, above a hyperbola.
 */
export function conicShape(start: Vec2, apex: Vec2, end: Vec2, rho: number): Nurbs {
  if (!(rho > 0 && rho < 1)) throw new FormatError('a conic rho lies strictly between 0 and 1');
  return {
    kind: 'nurbs',
    degree: 2,
    poles: [start, apex, end],
    weights: [1, rho / (1 - rho), 1],
    knots: [0, 1],
    multiplicities: [3, 3],
    periodic: false,
  };
}

/** The B-spline basis functions of `degree` over the flat knot vector `flat`, at `u`. */
function basis(flat: readonly number[], degree: number, count: number, u: number): number[] {
  // The span holding `u`; the last parameter belongs to the last non-empty span.
  let span = count - 1;
  if (u < at(flat, count)) {
    span = degree;
    while (span < count - 1 && at(flat, span + 1) <= u) span++;
  }
  const local: number[] = [1];
  const left: number[] = [0];
  const right: number[] = [0];
  for (let j = 1; j <= degree; j++) {
    left[j] = u - at(flat, span + 1 - j);
    right[j] = at(flat, span + j) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = at(local, r) / (at(right, r + 1) + at(left, j - r));
      local[r] = saved + at(right, r + 1) * temp;
      saved = at(left, j - r) * temp;
    }
    local[j] = saved;
  }
  const n: number[] = new Array<number>(count).fill(0);
  for (let j = 0; j <= degree; j++) n[span - degree + j] = at(local, j);
  return n;
}

/** Solves `a · x = b` for each column of `b` by Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: Vec2[]): Vec2[] {
  const size = a.length;
  const m = a.map((row) => [...row]);
  const rhs = b.map((p): [number, number] => [p[0], p[1]]);
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let r = col + 1; r < size; r++) {
      if (Math.abs(at(at(m, r), col)) > Math.abs(at(at(m, pivot), col))) pivot = r;
    }
    if (Math.abs(at(at(m, pivot), col)) < 1e-14) throw new FormatError('the spline points do not determine a curve');
    [m[col], m[pivot]] = [at(m, pivot), at(m, col)];
    [rhs[col], rhs[pivot]] = [at(rhs, pivot), at(rhs, col)];
    const top = at(m, col);
    for (let r = col + 1; r < size; r++) {
      const row = at(m, r);
      const f = at(row, col) / at(top, col);
      if (f === 0) continue;
      for (let c = col; c < size; c++) row[c] = at(row, c) - f * at(top, c);
      const rr = at(rhs, r);
      const rc = at(rhs, col);
      rhs[r] = [rr[0] - f * rc[0], rr[1] - f * rc[1]];
    }
  }
  const x: [number, number][] = new Array<[number, number]>(size);
  for (let r = size - 1; r >= 0; r--) {
    const row = at(m, r);
    let sx = at(rhs, r)[0];
    let sy = at(rhs, r)[1];
    for (let c = r + 1; c < size; c++) {
      const xc = at(x, c);
      sx -= at(row, c) * xc[0];
      sy -= at(row, c) * xc[1];
    }
    x[r] = [sx / at(row, r), sy / at(row, r)];
  }
  return x;
}

/**
 * The curve of a spline row through `through`, in order: the clamped B-spline
 * of degree 3 (2 through three points; a line through two) with as many
 * control points as points, parameters by normalized cumulative chord length
 * and interior knots by averaging consecutive parameters (de Boor).
 */
export function splineShape(through: readonly Vec2[]): CurveShape {
  const count = through.length;
  if (count < 2) throw new FormatError('a spline passes two or more points');
  const chords: number[] = [];
  for (let i = 1; i < count; i++) {
    const d = distance(at(through, i - 1), at(through, i));
    if (!(d > 0)) throw new FormatError('a spline passes the same place twice in a row');
    chords.push(d);
  }
  if (count === 2) return { kind: 'line', start: at(through, 0), end: at(through, 1) };
  const degree = Math.min(3, count - 1);
  const total = chords.reduce((s, d) => s + d, 0);
  const params = [0];
  for (let i = 1; i < count - 1; i++) params.push(at(params, i - 1) + at(chords, i - 1) / total);
  params.push(1);
  const interior: number[] = [];
  for (let j = 1; j <= count - degree - 1; j++) {
    let sum = 0;
    for (let i = j; i < j + degree; i++) sum += at(params, i);
    interior.push(sum / degree);
  }
  const flat = [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
  const matrix = params.map((u) => basis(flat, degree, count, u));
  const poles = solveLinear(matrix, [...through]);
  return {
    kind: 'nurbs',
    degree,
    poles,
    weights: new Array<number>(count).fill(1),
    knots: [0, ...interior, 1],
    multiplicities: [degree + 1, ...interior.map(() => 1), degree + 1],
    periodic: false,
  };
}
