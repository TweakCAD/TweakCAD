import type { Arrangement } from './arrangement';
import { at, boundsOf } from './curves';
import { againstPolygon, cyclePolyline, locateInCycle, type DetectedRegion } from './detect';
import type { Vec2 } from './types';

/** How far inside a sample point must lie, as a share of the bounding-box diagonal. */
const SAMPLE_MARGIN = 1e-6;

/** Points tried before settling for the deepest one seen. */
const SAMPLE_LIMIT = 2 ** 20;

/** The dyadic sequence 1/2; 1/4, 3/4; 1/8, 3/8, 5/8, 7/8; … from index 0. */
function dyadic(index: number): number {
  const level = Math.floor(Math.log2(index + 1));
  const within = index + 1 - 2 ** level;
  return (2 * within + 1) / 2 ** (level + 1);
}

function placeInRegion(arrangement: Arrangement, region: DetectedRegion, p: Vec2): { inside: boolean; depth: number } {
  const outer = locateInCycle(arrangement, region.outer, p);
  if (!outer.inside) return { inside: false, depth: 0 };
  let depth = outer.distance;
  for (const hole of region.inner) {
    const here = locateInCycle(arrangement, hole, p);
    if (here.inside) return { inside: false, depth: 0 };
    depth = Math.min(depth, here.distance);
  }
  return { inside: true, depth };
}

/**
 * The region's sample point: the first point of the dyadic sequence over its
 * bounding box, x fastest, inside it and clear of its boundary. The sequence
 * grows by levels: each level takes every pair of the first 2^n - 1 terms not
 * yet tried. Null when no tried point lies inside.
 */
export function regionSamplePoint(arrangement: Arrangement, region: DetectedRegion): Vec2 | null {
  const box = boundsOf(cyclePolyline(arrangement, region.outer, 4));
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const margin = SAMPLE_MARGIN * Math.hypot(width, height);
  let deepest: { p: Vec2; depth: number } | null = null;
  let tried = 0;
  for (let level = 1; tried < SAMPLE_LIMIT; level++) {
    const before = 2 ** (level - 1) - 1;
    const size = 2 ** level - 1;
    for (let j = 0; j < size && tried < SAMPLE_LIMIT; j++) {
      for (let i = 0; i < size && tried < SAMPLE_LIMIT; i++) {
        if (i < before && j < before) continue;
        tried++;
        const p: Vec2 = [box.minX + dyadic(i) * width, box.minY + dyadic(j) * height];
        const { inside, depth } = placeInRegion(arrangement, region, p);
        if (!inside) continue;
        if (depth > margin) return p;
        if (!deepest || depth > deepest.depth) deepest = { p, depth };
      }
    }
  }
  return deepest ? deepest.p : null;
}

/**
 * The sign of `p` against the live curves of a key: an open curve gives +1 to
 * the left of its direction at the closest point, a closed curve +1 outside and
 * -1 inside. Null when `p` lies on the curve or the closest points disagree.
 */
export function sideOfKey(arrangement: Arrangement, key: string, p: Vec2): 1 | -1 | null {
  const group = arrangement.byKey.get(key) ?? [];
  const nearest: { sign: 1 | -1 | null; distance: number }[] = [];
  for (const live of group) {
    const { curve } = live;
    for (const hit of curve.closest(p)) {
      let sign: 1 | -1 | null;
      if (curve.closed) {
        sign = againstPolygon(p, curve.flatten(curve.tMin, curve.tMax, 8)).inside ? -1 : 1;
      } else {
        const towards = hit.t >= curve.tMax ? -1 : 1;
        const [dx, dy] = curve.direction(hit.t, towards);
        const q = curve.point(hit.t);
        const cross = towards * (dx * (p[1] - q[1]) - dy * (p[0] - q[0]));
        sign = cross > 0 ? 1 : cross < 0 ? -1 : null;
      }
      nearest.push({ sign, distance: hit.distance });
    }
  }
  if (nearest.length === 0) return null;
  const best = Math.min(...nearest.map((n) => n.distance));
  if (best <= arrangement.tolerance) return null;
  const signs = new Set(nearest.filter((n) => n.distance <= best * (1 + 1e-9)).map((n) => n.sign));
  return signs.size === 1 ? at([...signs], 0) : null;
}
