/** Which regions of a sketch FreeCAD makes faces of. */
import type { DetectedRegion, Detection } from '@tweakcad/format';

type P2 = [number, number];

/** Point-in-polygon by ray crossing. */
function inside(p: P2, polygon: readonly P2[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = [polygon[i] as P2, polygon[j] as P2];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function polygonOf(detection: Detection, halfEdges: readonly number[]): P2[] {
  const out: P2[] = [];
  for (const h of halfEdges) {
    const edge = detection.arrangement.edges[h >> 1];
    const live = edge && detection.arrangement.curves[edge.curve];
    if (!edge || !live) continue;
    const [t0, t1] = (h & 1) === 0 ? [edge.t0, edge.t1] : [edge.t1, edge.t0];
    for (let i = 0; i < 32; i++) out.push(live.curve.point(t0 + ((t1 - t0) * i) / 32) as P2);
  }
  return out;
}

/** A point inside a region, off its boundary: the middle of the first span a scanline finds inside it. */
function interiorPoint(outer: P2[], holes: P2[][]): P2 | undefined {
  const ys = outer.map((p) => p[1]);
  const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
  for (const f of [0.5, 0.37, 0.63, 0.21, 0.79, 0.11, 0.89]) {
    const y = lo + (hi - lo) * f;
    const xs: number[] = [];
    for (const poly of [outer, ...holes]) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [a, b] = [poly[i] as P2, poly[j] as P2];
        if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const [x0, x1] = [xs[i] as number, xs[i + 1] as number];
      if (x1 - x0 > 1e-6 * Math.max(1, hi - lo)) return [(x0 + x1) / 2, y];
    }
  }
  return undefined;
}

/**
 * Nested closed wires alternate between material and hole in FreeCAD's face
 * maker, so a region inside an even number of other regions' outer boundaries
 * is a face.
 */
export function faceRegions(detection: Detection): DetectedRegion[] {
  const outers = detection.regions.map((r) => polygonOf(detection, r.outer.halfEdges));
  return detection.regions.filter((r, i) => {
    const sample = interiorPoint(
      outers[i] as P2[],
      r.inner.map((c) => polygonOf(detection, c.halfEdges)),
    );
    if (!sample) return false;
    const depth = outers.filter((poly, j) => j !== i && inside(sample, poly)).length;
    return depth % 2 === 0;
  });
}
