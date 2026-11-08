/** The curves sketch export writes, and geometry both exporters share. */
import type { CurveShape } from '@tweakcad/format';
import type { SketchGeometry } from '../geometry';
import type { P2 } from '../rows';

/** The shape of every curve that is drawn: not construction, not a point, and readable; then the extra ones (glyph contours). */
export function drawnShapes(geometry: SketchGeometry, extra: readonly CurveShape[] = []): CurveShape[] {
  const out: CurveShape[] = [];
  for (const view of geometry.curves.values()) {
    if (!view.construction && view.kind !== 'point' && view.shape) out.push(view.shape);
  }
  out.push(...extra);
  return out;
}

export const TAU = 2 * Math.PI;

export function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

export const sameAt = (a: P2, b: P2): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9 * Math.max(1, Math.abs(a[0]), Math.abs(a[1]));

/**
 * An ellipse with its longer axis as the major one: the unit major direction,
 * the radii, and the eccentric angle of a point on it.
 */
export function ellipseAxes(
  center: P2,
  majorEnd: P2,
  minorRadius: number,
): { ux: number; uy: number; major: number; minor: number; angleOf: (p: P2) => number } | null {
  let [dx, dy] = [majorEnd[0] - center[0], majorEnd[1] - center[1]];
  let major = Math.hypot(dx, dy);
  let minor = minorRadius;
  if (!(major > 0) || !(minor > 0)) return null;
  if (minor > major) {
    [dx, dy] = [-dy, dx];
    [major, minor] = [minor, major];
  }
  const [ux, uy] = [dx / Math.hypot(dx, dy), dy / Math.hypot(dx, dy)];
  const angleOf = (p: P2): number => {
    const [px, py] = [p[0] - center[0], p[1] - center[1]];
    return Math.atan2((-uy * px + ux * py) / minor, (ux * px + uy * py) / major);
  };
  return { ux, uy, major, minor, angleOf };
}
