/**
 * Picking a closed region of the sketch by a point inside it: the select
 * tool selects the smallest region holding the point (inside its outer
 * boundary and outside its holes), so a click in a ring picks the ring and
 * a click in the hole picks what fills the hole.
 */
import { cyclePolyline, type Detection } from '@tweakcad/format';
import type { P2 } from './rows';

/** The selection id prefix of a detected region; the number is its index in the detection. */
export const REGION_PREFIX = 'region:';

export const regionId = (index: number): string => `${REGION_PREFIX}${index}`;

/** The detection index a region selection id names, or null for another id. */
export function regionIndex(id: string): number | null {
  if (!id.startsWith(REGION_PREFIX)) return null;
  const n = Number(id.slice(REGION_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Even-odd containment of `p` in a closed polygon. */
function inside(p: P2, polygon: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 1; i < polygon.length; i++) {
    const a = polygon[i - 1] as readonly [number, number];
    const b = polygon[i] as readonly [number, number];
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0]) hit = !hit;
    }
  }
  return hit;
}

/** The index of the smallest region holding `p`, or null when none does. */
export function regionAt(detection: Detection, p: P2): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  detection.regions.forEach((region, i) => {
    if (region.area >= bestArea) return;
    if (!inside(p, cyclePolyline(detection.arrangement, region.outer, 1))) return;
    if (region.inner.some((hole) => inside(p, cyclePolyline(detection.arrangement, hole, 1)))) return;
    best = i;
    bestArea = region.area;
  });
  return best;
}

/**
 * A point inside region `index` of `detection` (inside its outer boundary,
 * outside its holes and in no smaller region), or null when none is found:
 * the outer boundary's vertex average, else a point just inside an edge's
 * midpoint.
 */
export function interiorPoint(detection: Detection, index: number): P2 | null {
  const region = detection.regions[index];
  if (!region) return null;
  const outer = cyclePolyline(detection.arrangement, region.outer, 1);
  const n = outer.length - 1;
  if (n < 3) return null;
  const candidates: P2[] = [];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const v = outer[i] as readonly [number, number];
    cx += v[0];
    cy += v[1];
  }
  candidates.push([cx / n, cy / n]);
  let size = 0;
  for (let i = 1; i <= n; i++) {
    const a = outer[i - 1] as readonly [number, number];
    const b = outer[i] as readonly [number, number];
    size = Math.max(size, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const step = Math.max(size * 1e-3, 1e-6);
  for (let i = 1; i <= n; i++) {
    const a = outer[i - 1] as readonly [number, number];
    const b = outer[i] as readonly [number, number];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    candidates.push([mx + nx * step, my + ny * step], [mx - nx * step, my - ny * step]);
  }
  return candidates.find((p) => regionAt(detection, p) === index) ?? null;
}
