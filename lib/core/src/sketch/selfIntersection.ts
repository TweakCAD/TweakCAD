/**
 * Self-intersection test for a closed 2D ring.
 *
 * A closed spline (or any closed boundary) whose curve crosses itself does
 * NOT bound a valid face. Handing such a boundary to OCCT's
 * `BRepBuilderAPI_MakeFace` makes it **spin** (no error, no result) — the
 * "stuck rebuilding" symptom on imported organic art. Callers use this to
 * reject the profile with a clear error *before* reaching the kernel.
 *
 * The test treats `points` as a closed polygon (last point implicitly
 * joins back to the first) and reports whether any two non-adjacent edges
 * properly cross. It's an O(n²) segment sweep — fine for the point counts
 * a sketch profile carries, run once per rebuild.
 */

type P = [number, number];

const EPS = 1e-9;

function orient(a: P, b: P, c: P): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: P, b: P, p: P): boolean {
  return (
    Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS &&
    Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS
  );
}

/** True iff segments a1a2 and b1b2 intersect (proper crossing or collinear
 *  overlap). Shared endpoints are NOT counted by the caller (adjacent edges
 *  are skipped), so a touch only at an endpoint here means a real overlap. */
function segmentsIntersect(a1: P, a2: P, b1: P, b2: P): boolean {
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);

  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }

  // Collinear-overlap cases.
  if (Math.abs(d1) <= EPS && onSegment(b1, b2, a1)) return true;
  if (Math.abs(d2) <= EPS && onSegment(b1, b2, a2)) return true;
  if (Math.abs(d3) <= EPS && onSegment(a1, a2, b1)) return true;
  if (Math.abs(d4) <= EPS && onSegment(a1, a2, b2)) return true;
  return false;
}

export function ringSelfIntersects(points: P[]): boolean {
  const n = points.length;
  if (n < 4) return false; // a triangle (or less) can't self-cross
  for (let i = 0; i < n; i++) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share a vertex with edge i (adjacent + the
      // wrap-around pair), since a shared endpoint isn't a self-crossing.
      if (j === i) continue;
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = points[j]!;
      const b2 = points[(j + 1) % n]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}
