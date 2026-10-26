/**
 * Euler ↔ quaternion conversion.
 *
 * The round-trip is what matters: the document stores quaternions, the
 * placement panel shows degrees, and a user who opens the panel and presses
 * Apply without touching anything must not nudge the component. A conversion
 * pair that disagrees about rotation order would do exactly that, silently,
 * and only on already-rotated instances.
 */
import { describe, expect, it } from 'vitest';
import {
  eulerDegreesFromQuaternion,
  quaternionFromEulerDegrees,
} from './math.ts';
import type { Quaternion, Vec3 } from './math.ts';

/** Rotate a vector by a quaternion — the only observable that matters. */
function rotate(q: Quaternion, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q.xyz × v); v' = v + w*t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function expectVecClose(actual: Vec3, expected: Vec3, precision = 6) {
  for (let i = 0; i < 3; i++) {
    expect(actual[i], `axis ${i}`).toBeCloseTo(expected[i]!, precision);
  }
}

describe('quaternionFromEulerDegrees', () => {
  it('produces the identity for no rotation', () => {
    expectVecClose(
      quaternionFromEulerDegrees(0, 0, 0).slice(0, 3) as Vec3,
      [0, 0, 0],
    );
    expect(quaternionFromEulerDegrees(0, 0, 0)[3]).toBeCloseTo(1, 9);
  });

  it('rotates +X onto +Y for 90° about Z', () => {
    expectVecClose(rotate(quaternionFromEulerDegrees(0, 0, 90), [1, 0, 0]), [0, 1, 0]);
  });

  it('rotates +Z onto +X for 90° about Y', () => {
    expectVecClose(rotate(quaternionFromEulerDegrees(0, 90, 0), [0, 0, 1]), [1, 0, 0]);
  });

  it('rotates +Y onto +Z for 90° about X', () => {
    expectVecClose(rotate(quaternionFromEulerDegrees(90, 0, 0), [0, 1, 0]), [0, 0, 1]);
  });

  it('produces a unit quaternion for an awkward angle triple', () => {
    const q = quaternionFromEulerDegrees(37, -118, 203);
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
  });
});

describe('eulerDegreesFromQuaternion', () => {
  it('reads back the identity as zero', () => {
    expectVecClose(eulerDegreesFromQuaternion([0, 0, 0, 1]), [0, 0, 0]);
  });

  it.each([
    [0, 0, 90],
    [0, 90, 0],
    [90, 0, 0],
    [30, 45, 60],
    [-15, 22.5, -170],
    [179, -89, 12],
  ])('round-trips (%s, %s, %s)', (x, y, z) => {
    const back = eulerDegreesFromQuaternion(quaternionFromEulerDegrees(x, y, z));
    expectVecClose(back, [x, y, z], 4);
  });

  it('round-trips the orientation at the pole even though the angles differ', () => {
    // Pitch ±90° makes X and Z indistinguishable, so the decomposition is one
    // of infinitely many. The orientation must still survive — that is what a
    // user pressing Apply without editing actually depends on.
    const original = quaternionFromEulerDegrees(40, 90, 25);
    const [x, y, z] = eulerDegreesFromQuaternion(original);
    const rebuilt = quaternionFromEulerDegrees(x, y, z);
    for (const probe of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
      expectVecClose(rotate(rebuilt, probe), rotate(original, probe), 4);
    }
  });

  it('does not return NaN for a slightly denormalised quaternion', () => {
    // Values that have been through JSON and a few edits drift off unit
    // length; asin would hand back NaN and blank every field in the panel.
    const drifted: Quaternion = [0, 0.7071458, 0, 0.7071458];
    expect(eulerDegreesFromQuaternion(drifted).every(Number.isFinite)).toBe(true);
  });
});
