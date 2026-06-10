/**
 * Pure 2D curve samplers shared across the editor render, the readonly
 * overlay, and the worker's profile→wire builder.
 *
 * Living in `lib/core` (not the app `src/`) lets the worker reuse the
 * exact same sampling the editor draws with — so an extruded spline edge
 * follows the same polyline the user saw in the sketch. The app-side
 * `src/sketch/curveTessellation.ts` re-exports these.
 */

/**
 * Sample a cubic Bézier curve (start, two control poles, end) into a
 * polyline of `samples + 1` points.
 */
export function sampleCubicBezier(
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p3: [number, number],
  samples: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([
      a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
      a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
    ]);
  }
  return out;
}

/**
 * Sample a Catmull-Rom spline through the given control points.
 * For fewer than 3 control points, returns the points unchanged (a single
 * straight segment). Phantom end points make the curve pass through every
 * control point.
 *
 * @param ctrl - Ordered control points (>=2)
 * @param subdivisions - Samples per span (>=1)
 */
export function catmullRomSpline(
  ctrl: [number, number][],
  subdivisions: number,
): [number, number][] {
  if (ctrl.length < 2) return ctrl.slice();
  if (ctrl.length === 2) return ctrl.slice();

  const out: [number, number][] = [];
  // Phantom points at the ends so the curve goes through every control point.
  const phantomBefore: [number, number] = [
    2 * ctrl[0]![0] - ctrl[1]![0],
    2 * ctrl[0]![1] - ctrl[1]![1],
  ];
  const phantomAfter: [number, number] = [
    2 * ctrl[ctrl.length - 1]![0] - ctrl[ctrl.length - 2]![0],
    2 * ctrl[ctrl.length - 1]![1] - ctrl[ctrl.length - 2]![1],
  ];
  const extended: [number, number][] = [phantomBefore, ...ctrl, phantomAfter];

  for (let i = 1; i < extended.length - 2; i++) {
    const p0 = extended[i - 1]!;
    const p1 = extended[i]!;
    const p2 = extended[i + 1]!;
    const p3 = extended[i + 2]!;
    for (let j = 0; j <= subdivisions; j++) {
      const t = j / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      if (out.length === 0 || out[out.length - 1]![0] !== x || out[out.length - 1]![1] !== y) {
        out.push([x, y]);
      }
    }
  }
  return out;
}

/**
 * Sample a **closed** Catmull-Rom curve through the control ring (no
 * closing duplicate — closure is implicit). Unlike {@link catmullRomSpline},
 * which uses reflected phantom endpoints and therefore kinks where a closed
 * loop wraps back to its start, this wraps the neighbour indices around the
 * ring so the seam is as smooth as every other span.
 *
 * Returns `ctrl.length * subdivisions` points forming the loop, with the
 * first point NOT repeated at the end (suitable for a periodic fit).
 *
 * @param ctrl - Ordered control points of the loop (>=3), first != last
 * @param subdivisions - Samples per span (>=1)
 */
export function catmullRomClosed(
  ctrl: [number, number][],
  subdivisions: number,
): [number, number][] {
  const n = ctrl.length;
  if (n < 3) return ctrl.slice();

  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n]!;
    const p1 = ctrl[i]!;
    const p2 = ctrl[(i + 1) % n]!;
    const p3 = ctrl[(i + 2) % n]!;
    // j < subdivisions (not <=) so each span emits its start + interior;
    // the next span's start continues the loop, and the final span's
    // continuation wraps to ctrl[0] without duplicating it.
    for (let j = 0; j < subdivisions; j++) {
      const t = j / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Sample a spline's control points into a display/outline polyline, picking
 * the right Catmull-Rom for its closure: a **closed** spline (first ≈ last
 * control point) uses the *periodic* {@link catmullRomClosed} so its seam is
 * smooth and matches the extruded face; an **open** spline uses the
 * phantom-endpoint {@link catmullRomSpline}. Returns a closed polyline (last
 * point repeats the first) for the closed case so the outline draws shut.
 *
 * One source for the editor render, the readonly overlay, and the region
 * outline — so the sketch curve, the profile fill, and the solid all agree.
 */
export function sampleSplinePolyline(
  ctrl: [number, number][],
  subdivisions: number,
): [number, number][] {
  if (ctrl.length < 2) return ctrl.slice();
  const first = ctrl[0]!;
  const last = ctrl[ctrl.length - 1]!;
  const closed = ctrl.length >= 4 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6;
  if (closed) {
    const ring = ctrl.slice(0, -1);
    if (ring.length >= 3) {
      const samples = catmullRomClosed(ring, subdivisions);
      return [...samples, samples[0]!];
    }
  }
  return catmullRomSpline(ctrl, subdivisions);
}

/**
 * Sample a full ellipse into `samples` points around its perimeter (open
 * list — the first point is NOT repeated at the end, suitable for a
 * periodic interpolation).
 *
 * The ellipse is given the way `SketchEllipseEntity` stores it: a `center`,
 * the absolute `majorEnd` point (which encodes both the major radius and
 * the in-plane rotation), and the `minorRadius`. The minor axis is the
 * major direction rotated +90°.
 */
export function sampleEllipse(
  center: [number, number],
  majorEnd: [number, number],
  minorRadius: number,
  samples: number,
): [number, number][] {
  const dx = majorEnd[0] - center[0];
  const dy = majorEnd[1] - center[1];
  const majorRadius = Math.hypot(dx, dy);
  // Major-axis unit vector (fallback to +x for a degenerate major axis).
  const ux = majorRadius > 0 ? dx / majorRadius : 1;
  const uy = majorRadius > 0 ? dy / majorRadius : 0;
  // Minor-axis unit vector = major rotated +90°.
  const vx = -uy;
  const vy = ux;

  const out: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const t = (2 * Math.PI * i) / samples;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([
      center[0] + majorRadius * c * ux + minorRadius * s * vx,
      center[1] + majorRadius * c * uy + minorRadius * s * vy,
    ]);
  }
  return out;
}
