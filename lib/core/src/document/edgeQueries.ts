/**
 * Edge queries over a body's TopologyMap.
 *
 * Shared by the `find_edges` tool (face-adjacency filters) and the
 * Fillet / Chamfer edge pickers (face → boundary edges, tangent chains).
 * Pure functions over the published topology — no kernel round trip.
 */

import type { TopologyMap } from './schema.ts';

export type TopologyEdge = TopologyMap['edges'][number];

/** Face-adjacency filter. Both fields optional; when both are set they AND. */
export type EdgeFaceFilter = {
  /** Keep edges touching ANY of these faces. */
  adjacentToFaceIds?: ReadonlySet<string> | null;
  /** Keep edges whose two adjacent faces are exactly this unordered pair. */
  betweenFaces?: readonly [string, string] | null;
};

/** True when an edge's adjacent-face pair passes the filter. */
export function edgeMatchesFaceFilter(
  adjacentFaces: readonly [unknown, unknown],
  filter: EdgeFaceFilter,
): boolean {
  const a = String(adjacentFaces[0]);
  const b = String(adjacentFaces[1]);
  const adjacent = filter.adjacentToFaceIds;
  if (adjacent && !adjacent.has(a) && !adjacent.has(b)) return false;
  const between = filter.betweenFaces;
  if (between) {
    const want = new Set(between);
    const have = new Set([a, b]);
    if (want.size !== have.size) return false;
    for (const w of want) if (!have.has(w)) return false;
  }
  return true;
}

/**
 * Seam edges (a periodic face closing on itself, e.g. a cylinder wall)
 * and free edges border a single face, reported twice. They are not
 * fillet/chamfer targets.
 */
export function isSeamEdge(edge: TopologyEdge): boolean {
  return String(edge.adjacentFaces[0]) === String(edge.adjacentFaces[1]);
}

/**
 * The edges bounding a face — every edge adjacent to it except seams.
 * Topology order is preserved.
 */
export function faceBoundaryEdges(topo: TopologyMap, faceId: string): TopologyEdge[] {
  const filter: EdgeFaceFilter = { adjacentToFaceIds: new Set([faceId]) };
  return topo.edges.filter(e => !isSeamEdge(e) && edgeMatchesFaceFilter(e.adjacentFaces, filter));
}

/**
 * Max angle between two edges' end tangents at a shared vertex for them
 * to count as tangent. The tangents are estimated from the edge polylines
 * (see {@link endTangent}); the residual error is a few degrees even for
 * 45° chords, well inside this.
 */
export const TANGENT_ANGLE_TOLERANCE = 0.15;

/** Vertex coincidence tolerance (mm). Shared vertices are emitted identically. */
const VERTEX_TOLERANCE = 1e-3;

type Vec3 = [number, number, number];

type EdgeEnds = {
  edge: TopologyEdge;
  start: Vec3;
  end: Vec3;
  /** Unit tangent at the start, pointing into the edge. */
  startDir: Vec3;
  /** Unit tangent at the end, pointing out of the edge. */
  endDir: Vec3;
};

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : null;
}

function near(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) <= VERTEX_TOLERANCE
    && Math.abs(a[1] - b[1]) <= VERTEX_TOLERANCE
    && Math.abs(a[2] - b[2]) <= VERTEX_TOLERANCE;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function neg(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * Tangent at a polyline end from its first chord `c1` and the next chord
 * `c2` (unit vectors, `c2` null for a single-segment edge). An end chord
 * of a curved edge lags the true tangent by half the chord's turn, which
 * on the coarse edge polylines is ~9° for a quarter arc in 5 chords.
 * Stepping back half a turn (1.5·c1 − 0.5·c2) recovers it to well under
 * a degree for evenly spaced chords.
 */
function endTangent(c1: Vec3, c2: Vec3 | null): Vec3 {
  if (!c2) return c1;
  return unit([1.5 * c1[0] - 0.5 * c2[0], 1.5 * c1[1] - 0.5 * c2[1], 1.5 * c1[2] - 0.5 * c2[2]]) ?? c1;
}

/** Endpoints + end tangents from a LineSegments buffer (6 floats per segment). */
function edgeEnds(edge: TopologyEdge): EdgeEnds | null {
  const s = edge.lineSegments;
  const n = s.length;
  if (n < 6) return null;
  const at = (i: number): Vec3 => [s[i] ?? 0, s[i + 1] ?? 0, s[i + 2] ?? 0];
  // Segment k runs from at(6k) to at(6k + 3).
  const chord = (k: number): Vec3 | null => unit(sub(at(6 * k + 3), at(6 * k)));
  const segs = Math.floor(n / 6);
  const first = chord(0);
  const last = chord(segs - 1);
  if (!first || !last) return null;
  const second = segs > 1 ? chord(1) : null;
  const penult = segs > 1 ? chord(segs - 2) : null;
  return {
    edge,
    start: at(0),
    end: at(n - 3),
    startDir: endTangent(first, second),
    // Walk the end backwards so the same rule applies, then flip.
    endDir: neg(endTangent(neg(last), penult ? neg(penult) : null)),
  };
}

/**
 * The tangent-continuous chain through `seedEdgeId`: the seed plus every
 * edge reachable through vertices where consecutive edges meet within
 * {@link TANGENT_ANGLE_TOLERANCE}. Seam edges never join a chain. Returns
 * the seed first, then neighbours in breadth-first order; an unknown
 * seed yields an empty list.
 */
export function tangentChain(
  topo: TopologyMap,
  seedEdgeId: string,
  angleTolerance: number = TANGENT_ANGLE_TOLERANCE,
): TopologyEdge[] {
  const seed = topo.edges.find(e => String(e.edgeId) === seedEdgeId);
  if (!seed) return [];
  if (isSeamEdge(seed)) return [seed];
  const seedEnds = edgeEnds(seed);
  if (!seedEnds) return [seed];

  const candidates: EdgeEnds[] = [];
  for (const e of topo.edges) {
    if (e === seed || isSeamEdge(e)) continue;
    const ends = edgeEnds(e);
    if (ends) candidates.push(ends);
  }

  const minDot = Math.cos(angleTolerance);
  const visited = new Set<TopologyEdge>([seed]);
  const chain: TopologyEdge[] = [seed];
  const queue: EdgeEnds[] = [seedEnds];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi] as EdgeEnds;
    // Leaving `cur` through either end: the outgoing direction there.
    const exits: Array<[Vec3, Vec3]> = [
      [cur.end, cur.endDir],
      [cur.start, neg(cur.startDir)],
    ];
    for (const [p, out] of exits) {
      for (const c of candidates) {
        if (visited.has(c.edge)) continue;
        // Entering `c` at whichever end sits on p.
        const entries: Vec3[] = [];
        if (near(c.start, p)) entries.push(c.startDir);
        if (near(c.end, p)) entries.push(neg(c.endDir));
        if (entries.some(dir => dot(out, dir) >= minDot)) {
          visited.add(c.edge);
          chain.push(c.edge);
          queue.push(c);
        }
      }
    }
  }
  return chain;
}
