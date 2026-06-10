/**
 * Remove coincident points before handing a point list to OCCT's
 * `GeomAPI_Interpolate` (occt-wasm `interpolatePoints`).
 *
 * The interpolator throws a `Standard_ConstructionError` (surfaced as a
 * `WebAssembly.Exception`) if any two consecutive points coincide — and
 * imported DXF/SVG splines routinely carry repeated fit points. Stripping
 * consecutive near-duplicates (and, for a periodic curve, a first==last
 * pair, since closure is implicit) makes the fit robust on real-world art.
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';

/** Points closer than this (mm) are treated as the same point. Comfortably
 *  above OCCT's interpolation confusion tolerance, far below visible. */
export const INTERPOLATION_COINCIDENT_TOL_MM = 1e-5;

export function dedupePointsForInterpolation(
  points: Vec3[],
  periodic: boolean,
  tol: number = INTERPOLATION_COINCIDENT_TOL_MM,
): Vec3[] {
  const tol2 = tol * tol;
  const near = (a: Vec3, b: Vec3): boolean => {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz <= tol2;
  };

  const out: Vec3[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last === undefined || !near(last, p)) out.push(p);
  }
  // A periodic curve closes implicitly, so a duplicated closing point would
  // collide with the start — drop it.
  if (periodic && out.length > 1 && near(out[0]!, out[out.length - 1]!)) {
    out.pop();
  }
  return out;
}
