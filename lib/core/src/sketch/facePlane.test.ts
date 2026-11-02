import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../math.ts';
import { nearestDefaultPlaneName, sketchFrameOnPlane } from './facePlane.ts';

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function expectVec(actual: Vec3, expected: Vec3) {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 9);
}

describe('sketchFrameOnPlane', () => {
  it('matches the default-plane axes on faces parallel to them', () => {
    // Same bases as DEFAULT_PLANES in the worker's resolvePlane.ts.
    const top = sketchFrameOnPlane([0, 1, 0], [3, 20, -4]);
    expectVec(top.uAxis, [1, 0, 0]);
    expectVec(top.vAxis, [0, 0, -1]);
    expectVec(top.origin, [0, 20, 0]);

    const front = sketchFrameOnPlane([0, 0, 1], [5, 5, 7]);
    expectVec(front.uAxis, [1, 0, 0]);
    expectVec(front.vAxis, [0, 1, 0]);
    expectVec(front.origin, [0, 0, 7]);

    const right = sketchFrameOnPlane([1, 0, 0], [12, 1, 1]);
    expectVec(right.uAxis, [0, 0, -1]);
    expectVec(right.vAxis, [0, 1, 0]);
    expectVec(right.origin, [12, 0, 0]);
  });

  it('stays right-handed on the opposite faces', () => {
    for (const n of [[0, -1, 0], [0, 0, -1], [-1, 0, 0]] as Vec3[]) {
      const f = sketchFrameOnPlane(n, [1, 2, 3]);
      expectVec(cross(f.uAxis, f.vAxis), n);
    }
    const bottom = sketchFrameOnPlane([0, -1, 0], [0, 0, 0]);
    expectVec(bottom.uAxis, [1, 0, 0]);
    expectVec(bottom.vAxis, [0, 0, 1]);
  });

  it('builds an orthonormal right-handed frame for an oblique face', () => {
    const s = Math.SQRT1_2;
    const f = sketchFrameOnPlane([s, 0, s], [10, 0, 0]);
    expectVec(cross(f.uAxis, f.vAxis), [s, 0, s]);
    expectVec(f.vAxis, [0, 1, 0]);
    // Origin lies on the plane: n·origin = n·point.
    expect(f.origin[0] * s + f.origin[2] * s).toBeCloseTo(10 * s, 9);
  });

  it('depends only on the plane, not on the point picked on it', () => {
    const a = sketchFrameOnPlane([0, 1, 0], [0, 15, 0]);
    const b = sketchFrameOnPlane([0, 1, 0], [40, 15, -25]);
    expect(b).toEqual(a);
  });

  it('normalizes the normal and rejects a zero one', () => {
    expectVec(sketchFrameOnPlane([0, 5, 0], [0, 1, 0]).normal, [0, 1, 0]);
    expect(() => sketchFrameOnPlane([0, 0, 0], [0, 0, 0])).toThrow(/zero-length/);
  });
});

describe('nearestDefaultPlaneName', () => {
  it('picks the default plane whose normal is closest', () => {
    expect(nearestDefaultPlaneName([0, -1, 0])).toBe('XZ');
    expect(nearestDefaultPlaneName([0.1, 0.2, 0.9])).toBe('XY');
    expect(nearestDefaultPlaneName([-0.8, 0.1, 0.2])).toBe('YZ');
  });
});
