/**
 * Snapping the pointer while drawing: to sketch points, line midpoints, the
 * sketch origin and the sketch axes, then the grid, in that order of
 * priority, each within a radius of screen pixels. A snap says which
 * constraint the tool writes for it.
 */
import type { SketchGeometry } from './geometry';
import type { P2 } from './rows';

/** Screen pixels within which a target snaps. */
export const SNAP_PIXELS = 8;

export type Snap =
  /** An existing sketch point: the new geometry shares it. */
  | { kind: 'point'; id: string; at: P2 }
  /** The sketch origin, where no point is: the new point is held there by constraints against it. */
  | { kind: 'origin'; at: P2 }
  /** A line's midpoint: the new point gets a midpoint constraint. */
  | { kind: 'midpoint'; curve: string; at: P2 }
  /** On the sketch x axis (y = 0) or y axis (x = 0): a point-on-curve constraint against it. */
  | { kind: 'axisX' | 'axisY'; at: P2 }
  | { kind: 'grid'; at: P2 }
  | { kind: 'none'; at: P2 };

export interface SnapOptions {
  /** Millimetres per screen pixel. */
  pixel: number;
  /** Points not to snap to: the ones being dragged. */
  exclude?: ReadonlySet<string>;
  /** Grid spacing in mm when grid snapping is on. */
  grid?: number | null;
}

export function snapAt(geometry: SketchGeometry, uv: P2, options: SnapOptions): Snap {
  const radius = SNAP_PIXELS * options.pixel;
  const exclude = options.exclude ?? new Set<string>();
  const near = (p: P2) => Math.hypot(p[0] - uv[0], p[1] - uv[1]);

  let best: Snap | null = null;
  let bestDistance = radius;
  for (const [id, p] of geometry.points) {
    if (exclude.has(id) || !geometry.used.has(id)) continue;
    const d = near(p);
    if (d < bestDistance) {
      bestDistance = d;
      best = { kind: 'point', id, at: p };
    }
  }
  // A point lying on the origin wins over the origin itself.
  if (near([0, 0]) < bestDistance) best = { kind: 'origin', at: [0, 0] };
  if (best) return best;

  bestDistance = radius;
  for (const c of geometry.curves.values()) {
    if (c.kind !== 'line' || exclude.has(c.row.start as string) || exclude.has(c.row.end as string)) continue;
    const m = geometry.midpoint(c.id);
    if (!m) continue;
    const d = near(m);
    if (d < bestDistance) {
      bestDistance = d;
      best = { kind: 'midpoint', curve: c.id, at: m };
    }
  }
  if (best) return best;

  const [dx, dy] = [Math.abs(uv[1]), Math.abs(uv[0])];
  if (dx < radius && dx <= dy) return { kind: 'axisX', at: [uv[0], 0] };
  if (dy < radius) return { kind: 'axisY', at: [0, uv[1]] };

  const grid = options.grid;
  if (grid && grid > 0) return { kind: 'grid', at: [Math.round(uv[0] / grid) * grid, Math.round(uv[1] / grid) * grid] };
  return { kind: 'none', at: uv };
}

/** Within this many degrees of horizontal or vertical, a line drawn free is made so. */
export const INFER_DEGREES = 5;

/** Horizontal or vertical when the line from `a` to `b` is within `INFER_DEGREES` of it and long enough to tell. */
export function inferAxis(a: P2, b: P2, pixel: number): 'horizontal' | 'vertical' | null {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  if (Math.hypot(dx, dy) < Math.max(1e-9, 4 * pixel)) return null;
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  const tolerance = (INFER_DEGREES * Math.PI) / 180;
  if (angle < tolerance) return 'horizontal';
  if (Math.PI / 2 - angle < tolerance) return 'vertical';
  return null;
}
