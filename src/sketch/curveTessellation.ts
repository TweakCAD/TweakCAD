/**
 * Shared 2D curve tessellation for sketch rendering.
 *
 * Both the interactive editor scene (`SketchSceneManager`) and the readonly
 * overlay (`SketchViewer`) sample splines into polylines for display. Keeping
 * one implementation here means a spline looks identical whether the sketch
 * is being edited or shown after exit.
 */

/**
 * Sample a cubic Bezier curve (start, two control poles, end) into a polyline
 * of `samples + 1` points. Used to display/hit-test `bezier` sketch geometry
 * consistently in the editor scene and the readonly overlay.
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
