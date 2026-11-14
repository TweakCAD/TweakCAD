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

describe('snapAt onto curves', () => {
  const values = new ValueEvaluator({ values: [flag] });
  const curve = (id: string, kind: string, fields: Json): Json => ({
    id,
    kind,
    construction: flag,
    origin: { drawn: {} },
    ...fields,
  });
  const curves = new SketchGeometry(
    {
      points: [
        { id: 'pt_a', x: 10, y: 10 },
        { id: 'pt_b', x: 30, y: 10 },
        { id: 'pt_c', x: 50, y: 50 },
        { id: 'pt_s', x: 80, y: 40 },
        { id: 'pt_e', x: 60, y: 40 },
        { id: 'pt_m', x: 70, y: 40 },
        { id: 'pt_q0', x: 20, y: 80 },
        { id: 'pt_q1', x: 30, y: 90 },
        { id: 'pt_q2', x: 40, y: 80 },
      ],
      curves: [
        curve('crv_l', 'line', { start: 'pt_a', end: 'pt_b' }),
        curve('crv_c', 'circle', { center: 'pt_c', radius: 10 }),
        // The upper half of the circle of radius 10 about (70, 40), counter-clockwise from (80, 40).
        curve('crv_r', 'arc', { center: 'pt_m', start: 'pt_s', end: 'pt_e' }),
        curve('crv_sp', 'spline', { through: ['pt_q0', 'pt_q1', 'pt_q2'] }),
      ],
      constraints: [],
    },
    values,
  );

  it('puts the point at the nearest point of a line, circle or arc', () => {
    expect(snapAt(curves, [15, 10.5], { pixel })).toEqual({
      kind: 'curve',
      curve: 'crv_l',
      external: false,
      at: [15, 10],
    });
    const onCircle = snapAt(curves, [60.4, 50], { pixel });
    expect(onCircle).toMatchObject({ kind: 'curve', curve: 'crv_c', external: false });
    expect(onCircle.at[0]).toBeCloseTo(60, 9);
    expect(onCircle.at[1]).toBeCloseTo(50, 9);
    const onArc = snapAt(curves, [70, 50.5], { pixel });
    expect(onArc).toMatchObject({ kind: 'curve', curve: 'crv_r' });
    expect(onArc.at[0]).toBeCloseTo(70, 9);
    expect(onArc.at[1]).toBeCloseTo(50, 9);
  });

  it('snaps only within eight pixels, and only along the curve itself', () => {
    expect(snapAt(curves, [15, 10.9], { pixel }).kind).toBe('none');
    // Past the line's end, and below the arc on its circle.
    expect(snapAt(curves, [32, 10.3], { pixel }).kind).toBe('none');
    expect(snapAt(curves, [70, 30.3], { pixel }).kind).toBe('none');
  });

  it('ranks below points and midpoints, takes the nearer of a curve and an axis, and wins over the grid', () => {
    expect(snapAt(curves, [10.4, 10.3], { pixel }).kind).toBe('point');
    expect(snapAt(curves, [20.3, 10.3], { pixel }).kind).toBe('midpoint');
    const near = new SketchGeometry(
      {
        points: [
          { id: 'pt_a', x: 10, y: 0.5 },
          { id: 'pt_b', x: 30, y: 0.5 },
        ],
        curves: [curve('crv_l', 'line', { start: 'pt_a', end: 'pt_b' })],
        constraints: [],
      },
      values,
    );
    expect(snapAt(near, [15, 0.4], { pixel }).kind).toBe('curve');
    expect(snapAt(near, [15, 0.1], { pixel }).kind).toBe('axisX');
    expect(snapAt(curves, [15, 10.5], { pixel, grid: 10 }).kind).toBe('curve');
  });

  it('skips through-point splines, curves through excluded points, and every curve when told', () => {
    const spline = curves.curves.get('crv_sp')?.curve;
    expect(spline).toBeTruthy();
    const onSpline = spline!.point(spline!.tMin + (spline!.tMax - spline!.tMin) / 4) as [number, number];
    expect(snapAt(curves, [onSpline[0], onSpline[1] + 0.2], { pixel }).kind).toBe('none');
    expect(snapAt(curves, [15, 10.5], { pixel, exclude: new Set(['pt_a']) }).kind).toBe('none');
    expect(snapAt(curves, [60.4, 50], { pixel, curves: false }).kind).toBe('none');
  });

  it('marks an external curve as external', () => {
    const shape = { kind: 'line' as const, start: [0, 30] as [number, number], end: [40, 30] as [number, number] };
    const withExternal = new SketchGeometry(
      { points: [], curves: [curve('crv_x', 'external', {})], constraints: [] },
      values,
      new Map([['crv_x', shape]]),
    );
    expect(snapAt(withExternal, [20, 30.4], { pixel })).toEqual({
      kind: 'curve',
      curve: 'crv_x',
      external: true,
      at: [20, 30],
    });
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
