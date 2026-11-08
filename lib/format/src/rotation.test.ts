import { describe, expect, it } from 'vitest';
import { canonicalRotation, hasCanonicalSign, isUnitQuaternion } from './rotation';

describe('rotations', () => {
  it('flips to w ≥ 0', () => {
    expect(canonicalRotation([0, 0, -0.6, -0.8])).toEqual([0, 0, 0.6, 0.8]);
    expect(canonicalRotation([0, 0, 0.6, 0.8])).toEqual([0, 0, 0.6, 0.8]);
  });

  it('uses the first non-zero component when w = 0', () => {
    expect(canonicalRotation([0, -1, 0, 0])).toEqual([0, 1, 0, 0]);
    expect(canonicalRotation([-0.6, 0.8, 0, 0])).toEqual([0.6, -0.8, 0, 0]);
    expect(hasCanonicalSign([0, 1, 0, 0])).toBe(true);
    expect(hasCanonicalSign([0, -1, 0, 0])).toBe(false);
  });

  it('writes no negative zeros', () => {
    const q = canonicalRotation([-0, -0, -1, -0]);
    expect(q.map((c) => Object.is(c, -0))).toEqual([false, false, false, false]);
    expect(q).toEqual([0, 0, 1, 0]);
  });

  it('accepts unit quaternions within 1e-9 only', () => {
    expect(isUnitQuaternion([0, 0, 0, 1])).toBe(true);
    expect(isUnitQuaternion([0, 0, 0, 1 + 5e-10])).toBe(true);
    expect(isUnitQuaternion([0, 0, 0, 1 + 2e-9])).toBe(false);
    expect(isUnitQuaternion([0, 0, 1])).toBe(false);
    expect(isUnitQuaternion([0, 0, 0, NaN])).toBe(false);
  });
});
