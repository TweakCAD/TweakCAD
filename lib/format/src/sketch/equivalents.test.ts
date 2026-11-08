import { describe, expect, it } from 'vitest';
import { FormatError } from '../collections';
import { prepareCurve } from './curves';
import { bezierShape, conicShape, splineShape } from './equivalents';
import type { CurveShape, Vec2 } from './types';

const curveOf = (shape: CurveShape) => {
  const c = prepareCurve(shape, false);
  if (!c) throw new Error('no curve');
  return c;
};
const near = (a: Vec2, b: Vec2) => {
  expect(a[0]).toBeCloseTo(b[0], 10);
  expect(a[1]).toBeCloseTo(b[1], 10);
};

describe('the NURBS a spline, bezier or conic stands for', () => {
  it('passes a spline through its points in order, at their chord-length parameters', () => {
    const through: Vec2[] = [
      [0, 0],
      [3, 4],
      [7, 1],
      [10, 6],
      [14, 2],
    ];
    const shape = splineShape(through);
    expect(shape.kind).toBe('nurbs');
    if (shape.kind !== 'nurbs') return;
    expect(shape.degree).toBe(3);
    expect(shape.poles).toHaveLength(5);
    expect(shape.multiplicities).toEqual([4, 1, 4]);
    const chords = [5, Math.hypot(4, 3), Math.hypot(3, 5), Math.hypot(4, 4)];
    const total = chords.reduce((s, d) => s + d, 0);
    // de Boor averaging: the one interior knot is the mean of the three inner parameters.
    const params = [
      0,
      chords[0]! / total,
      (chords[0]! + chords[1]!) / total,
      (chords[0]! + chords[1]! + chords[2]!) / total,
      1,
    ];
    expect(shape.knots[1]).toBeCloseTo((params[1]! + params[2]! + params[3]!) / 3, 12);
    const curve = curveOf(shape);
    params.forEach((u, i) => near(curve.point(u), through[i]!));
  });

  it('makes a quadratic through three points and a line through two', () => {
    const three = splineShape([
      [0, 0],
      [5, 5],
      [10, 0],
    ]);
    expect(three.kind === 'nurbs' && three.degree).toBe(2);
    near(curveOf(three).point(0.5), [5, 5]);
    expect(
      splineShape([
        [0, 0],
        [4, 3],
      ]),
    ).toEqual({ kind: 'line', start: [0, 0], end: [4, 3] });
  });

  it('refuses a spline that passes one place twice in a row', () => {
    expect(() =>
      splineShape([
        [0, 0],
        [0, 0],
        [3, 1],
      ]),
    ).toThrow(FormatError);
  });

  it('runs a bezier from its start to its end, pulled by its inner points', () => {
    const curve = curveOf(bezierShape([0, 0], [0, 6], [10, 6], [10, 0]));
    near(curve.point(0), [0, 0]);
    near(curve.point(1), [10, 0]);
    near(curve.point(0.5), [5, 4.5]);
  });

  it('crosses a conic at the fraction rho from the chord midpoint to the apex', () => {
    for (const rho of [0.3, 0.5, 0.8]) {
      const curve = curveOf(conicShape([0, 0], [5, 10], [10, 0], rho));
      near(curve.point(0.5), [5, 10 * rho]);
      near(curve.point(0), [0, 0]);
      near(curve.point(1), [10, 0]);
    }
    // rho 1/2 is the parabola: the plain quadratic Bezier.
    const parabola = curveOf(conicShape([0, 0], [5, 10], [10, 0], 0.5));
    near(parabola.point(0.25), [2.5, 2 * 0.25 * 0.75 * 10]);
    expect(() => conicShape([0, 0], [5, 10], [10, 0], 1)).toThrow(FormatError);
  });
});
