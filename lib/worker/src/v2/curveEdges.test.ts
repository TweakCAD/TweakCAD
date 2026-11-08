import { describe, expect, it } from 'vitest';
import { bezierShape, prepareCurve, type CurveShape } from '@tweakcad/format';
import { stretchMeasures } from './curveEdges';

const curveOf = (shape: CurveShape, closed = false) => {
  const c = prepareCurve(shape, closed);
  if (!c) throw new Error('no curve');
  return c;
};

describe('how far a point is from a stretch of a curve, and how far the stretch reaches', () => {
  it('measures a stretch of an ellipse, wrapping past its start', () => {
    const curve = curveOf({ kind: 'ellipse', center: [0, 0], majorEnd: [6, 0], minorRadius: 3 });
    // From a quarter turn short of the major end to a quarter turn past it: the right half.
    const m = stretchMeasures(curve, 1.5 * Math.PI, 2.5 * Math.PI);
    expect(m.distance([6, 0])).toBeLessThan(1e-9);
    expect(m.distance([6 * Math.cos(0.3), 3 * Math.sin(0.3)])).toBeLessThan(1e-9);
    // A point on the other half is as far as the nearer end of the stretch.
    expect(m.distance([-6, 0])).toBeCloseTo(Math.hypot(6, 3), 9);
    const [low, high] = m.span([1, 0]);
    expect(low).toBeCloseTo(0, 9);
    expect(high).toBeCloseTo(6, 9);
    const [down, up] = m.span([0, 1]);
    expect([down, up]).toEqual([expect.closeTo(-3, 9), expect.closeTo(3, 9)]);
  });

  it('finds the furthest reach of a bezier between its ends', () => {
    const curve = curveOf(bezierShape([0, 0], [0, 6], [10, 6], [10, 0]));
    const m = stretchMeasures(curve, 0, 1);
    // The bezier's crest is at its middle: 3/4 of the control height.
    expect(m.span([0, 1])[1]).toBeCloseTo(4.5, 10);
    expect(m.span([0, 1])[0]).toBeCloseTo(0, 10);
    const [a, b] = m.span([Math.SQRT1_2, Math.SQRT1_2]);
    expect(a).toBeCloseTo(0, 9);
    expect(b).toBeGreaterThan(10 * Math.SQRT1_2);
    expect(m.distance(curve.point(0.37))).toBeLessThan(1e-9);
    expect(m.distance([5, 6])).toBeGreaterThan(1);
  });
});
