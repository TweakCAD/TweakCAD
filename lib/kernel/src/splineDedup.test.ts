import { describe, it, expect } from 'vitest';
import { dedupePointsForInterpolation } from './splineDedup.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';

describe('dedupePointsForInterpolation', () => {
  it('drops consecutive coincident points (the interpolate-throws case)', () => {
    const pts: Vec3[] = [[0, 0, 0], [0, 0, 0], [10, 0, 0], [10, 0, 0], [10, 10, 0]];
    expect(dedupePointsForInterpolation(pts, false)).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 0]]);
  });

  it('treats sub-tolerance points as coincident', () => {
    const pts: Vec3[] = [[0, 0, 0], [1e-7, 0, 0], [5, 0, 0]];
    expect(dedupePointsForInterpolation(pts, false)).toEqual([[0, 0, 0], [5, 0, 0]]);
  });

  it('keeps distinct points untouched', () => {
    const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 1, 0]];
    expect(dedupePointsForInterpolation(pts, false)).toEqual(pts);
  });

  it('drops a duplicated closing point for a periodic curve', () => {
    // first == last → periodic closure is implicit, so the trailing copy
    // must go or the periodic interpolate throws.
    const ring: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 0, 0]];
    expect(dedupePointsForInterpolation(ring, true)).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 0]]);
  });

  it('does NOT drop first==last for a non-periodic curve', () => {
    const pts: Vec3[] = [[0, 0, 0], [5, 5, 0], [0, 0, 0]];
    expect(dedupePointsForInterpolation(pts, false)).toEqual(pts);
  });
});
