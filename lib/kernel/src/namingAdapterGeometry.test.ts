import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tweakcad/format';
import { agreedSign, compareVec3, firstClearPoint, orderLoop, type LoopUse } from './namingAdapterGeometry.ts';
import { NamingAdapterError } from './namingAdapterHistory.ts';

const at = (x: number): Vec3 => [x, 0, 0];

describe('firstClearPoint', () => {
  const tuples = [[1], [2], [3], [4]];

  it('takes the first point clear of the boundary', () => {
    const clearance: Record<number, number> = { 1: 0.5, 2: 5, 3: 9 };
    const probe = ([x = 0]: readonly number[]) => ({ point: at(x), clearance: clearance[x] ?? 0 });
    expect(firstClearPoint(tuples, probe, 1)).toEqual(at(2));
  });

  it('skips points outside', () => {
    const probe = ([x = 0]: readonly number[]) => (x < 3 ? null : { point: at(x), clearance: 2 });
    expect(firstClearPoint(tuples, probe, 1)).toEqual(at(3));
  });

  it('falls back to the farthest inside point, the earliest on ties', () => {
    const clearance: Record<number, number> = { 1: 0.1, 2: 0.4, 3: 0.4, 4: 0.2 };
    const probe = ([x = 0]: readonly number[]) => ({ point: at(x), clearance: clearance[x] ?? 0 });
    expect(firstClearPoint(tuples, probe, 1)).toEqual(at(2));
  });

  it('counts clearance exactly at the limit as too close', () => {
    const probe = ([x = 0]: readonly number[]) => ({ point: at(x), clearance: x === 1 ? 1 : 2 });
    expect(firstClearPoint(tuples, probe, 1)).toEqual(at(2));
  });

  it('is null when no tried point is inside', () => {
    expect(firstClearPoint(tuples, () => null, 1)).toBeNull();
  });

  it('stops at the limit', () => {
    const tried: number[] = [];
    const probe = ([x = 0]: readonly number[]) => {
      tried.push(x);
      return null;
    };
    expect(firstClearPoint(tuples, probe, 1, 2)).toBeNull();
    expect(tried).toEqual([1, 2]);
  });
});

describe('orderLoop', () => {
  const use = (edge: number, from: number, to: number): LoopUse<number> => ({ edge, reversed: false, from, to });

  it('leaves a connected cycle in stored order', () => {
    const loop = [use(1, 10, 20), use(2, 20, 30), use(3, 30, 10)];
    expect(orderLoop(loop)).toEqual(loop);
  });

  it('takes a one-edge loop and a seam walked both ways', () => {
    const single = [use(1, 10, 10)];
    expect(orderLoop(single)).toEqual(single);
    const wall = [use(1, 10, 10), use(2, 10, 20), use(3, 20, 20), use(2, 20, 10)];
    expect(orderLoop(wall)).toEqual(wall);
  });

  it('walks an out-of-order wire into a cycle', () => {
    const a = use(1, 10, 20);
    const b = use(2, 20, 30);
    const c = use(3, 30, 10);
    expect(orderLoop([a, c, b])).toEqual([a, b, c]);
  });

  it('finds the cycle of a cylinder wall stored so a greedy walk dead-ends', () => {
    const top = use(1, 20, 20);
    const up = use(2, 10, 20);
    const bottom = use(3, 10, 10);
    const down = use(2, 20, 10);
    expect(orderLoop([top, up, bottom, down])).toEqual([top, down, bottom, up]);
  });

  it('refuses a wire that does not connect or close', () => {
    expect(() => orderLoop([use(1, 10, 20), use(2, 30, 40)])).toThrow(NamingAdapterError);
    expect(() => orderLoop([use(1, 10, 20), use(2, 40, 50), use(3, 20, 30)])).toThrow(NamingAdapterError);
  });

  it('gives nothing for an empty wire', () => {
    expect(orderLoop([])).toEqual([]);
  });
});

describe('agreedSign', () => {
  it('gives the sign all closest points share', () => {
    expect(agreedSign([1, 1])).toBe(1);
    expect(agreedSign([-1])).toBe(-1);
  });

  it('is null when closest points disagree, when one has no sign, or when there are none', () => {
    expect(agreedSign([1, -1])).toBeNull();
    expect(agreedSign([1, 0])).toBeNull();
    expect(agreedSign([0, 1])).toBeNull();
    expect(agreedSign([])).toBeNull();
  });
});

describe('compareVec3', () => {
  it('orders by x, then y, then z', () => {
    const points: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 2],
      [0, 0, 1],
    ];
    expect(points.sort(compareVec3)).toEqual([
      [0, 0, 1],
      [0, 0, 2],
      [0, 1, 0],
      [1, 0, 0],
    ]);
  });
});
