/** Unit quaternion `[x, y, z, w]` (Hamilton). */
export type Quaternion = [number, number, number, number];

/** How far a stored rotation's norm may be from 1. */
export const UNIT_TOLERANCE = 1e-9;

/** True when `q` is four finite numbers whose norm is 1 within the tolerance. */
export function isUnitQuaternion(q: unknown): q is Quaternion {
  if (!Array.isArray(q) || q.length !== 4) return false;
  if (!q.every((c) => typeof c === 'number' && Number.isFinite(c))) return false;
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  return Math.abs(norm - 1) <= UNIT_TOLERANCE;
}

/**
 * True when `q` has the canonical sign: `w > 0`, or `w = 0` with the first
 * non-zero component positive.
 */
export function hasCanonicalSign(q: Quaternion): boolean {
  if (q[3] !== 0) return q[3] > 0;
  for (const c of [q[0], q[1], q[2]]) {
    if (c !== 0) return c > 0;
  }
  return false;
}

/** The same rotation with the canonical sign. Signed zeros become plain zeros. */
export function canonicalRotation(q: Quaternion): Quaternion {
  const flipped = hasCanonicalSign(q) ? q : (q.map((c) => -c) as Quaternion);
  return flipped.map((c) => (c === 0 ? 0 : c)) as Quaternion;
}
