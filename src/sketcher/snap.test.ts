import { ValueEvaluator } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import { SketchGeometry } from './geometry';
import type { Json } from './rows';
import { inferAxis, snapAt } from './snap';

const flag = { id: 'val_f', def: { expr: { text: 'false', grammar: 1, refs: {} } } };
const inputs: Json = {
  points: [
    { id: 'pt_a', x: 10, y: 10 },
    { id: 'pt_b', x: 30, y: 10 },
  ],
  curves: [{ id: 'crv_l', kind: 'line', construction: flag, origin: { drawn: {} }, start: 'pt_a', end: 'pt_b' }],
  constraints: [],
};
const geometry = new SketchGeometry(inputs, new ValueEvaluator({ values: [flag] }));
const pixel = 0.1;

describe('snapAt', () => {
  it('prefers points, then midpoints, then the origin and axes, then the grid', () => {
    expect(snapAt(geometry, [10.5, 10.2], { pixel })).toEqual({ kind: 'point', id: 'pt_a', at: [10, 10] });
    expect(snapAt(geometry, [20.3, 10.4], { pixel })).toEqual({ kind: 'midpoint', curve: 'crv_l', at: [20, 10] });
    expect(snapAt(geometry, [0.3, -0.2], { pixel })).toEqual({ kind: 'origin', at: [0, 0] });
    expect(snapAt(geometry, [15, 0.5], { pixel })).toEqual({ kind: 'axisX', at: [15, 0] });
    expect(snapAt(geometry, [-0.5, 25], { pixel })).toEqual({ kind: 'axisY', at: [0, 25] });
    expect(snapAt(geometry, [44, 47], { pixel, grid: 10 })).toEqual({ kind: 'grid', at: [40, 50] });
    expect(snapAt(geometry, [44, 47], { pixel })).toEqual({ kind: 'none', at: [44, 47] });
  });

  it('snaps within eight pixels, so zooming in narrows it', () => {
    expect(snapAt(geometry, [10.5, 10.5], { pixel: 0.05 }).kind).toBe('none');
    expect(snapAt(geometry, [10.5, 10.5], { pixel: 0.1 }).kind).toBe('point');
  });

  it('skips excluded points and their lines', () => {
    expect(snapAt(geometry, [10.2, 10.2], { pixel, exclude: new Set(['pt_a']) }).kind).toBe('none');
    expect(snapAt(geometry, [20.2, 10.2], { pixel, exclude: new Set(['pt_a']) }).kind).toBe('none');
  });

  it('prefers a point lying on the origin to the origin itself', () => {
    const onOrigin = new SketchGeometry(
      {
        ...inputs,
        points: [...(inputs.points as Json[]), { id: 'pt_o', x: 0, y: 0 }],
        curves: [
          ...(inputs.curves as Json[]),
          { id: 'crv_o', kind: 'point', construction: flag, origin: { drawn: {} }, at: 'pt_o' },
        ],
      },
      new ValueEvaluator({ values: [flag] }),
    );
    expect(snapAt(onOrigin, [0.3, 0.2], { pixel })).toEqual({ kind: 'point', id: 'pt_o', at: [0, 0] });
  });
});

describe('inferAxis', () => {
  it('finds lines within five degrees of horizontal or vertical', () => {
    expect(inferAxis([0, 0], [10, 0.8], pixel)).toBe('horizontal');
    expect(inferAxis([0, 0], [-0.8, -10], pixel)).toBe('vertical');
    expect(inferAxis([0, 0], [10, 1], pixel)).toBeNull();
    expect(inferAxis([0, 0], [0.2, 0], pixel)).toBeNull();
  });
});
