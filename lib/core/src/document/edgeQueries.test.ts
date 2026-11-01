import { describe, it, expect } from 'vitest';
import type { TopologyMap } from './schema.ts';
import { edgeMatchesFaceFilter, faceBoundaryEdges, isSeamEdge, tangentChain } from './edgeQueries.ts';

type Pt = [number, number, number];

/** LineSegments buffer (6 floats per segment) through consecutive points. */
function polyline(points: Pt[]): Float32Array {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) out.push(...points[i - 1]!, ...points[i]!);
  return new Float32Array(out);
}

/**
 * Arc at height z, tessellated into `n` chords. The default matches the
 * app's edge polylines: a quarter arc in 5 chords, whose end chord sits
 * ~9° off the tangent.
 */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, z: number, n = 5): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return pts;
}

const Q = Math.PI / 2;
const edge = (id: string, points: Pt[], faces: [string, string]) => ({
  edgeId: id,
  lineSegments: polyline(points),
  adjacentFaces: faces,
  stableEdgeId: `s_${id}`,
});

// A 20×20 plate, top at z=10, with 2 mm rounded corners and a Ø6 through
// hole. The top outline is 4 lines + 4 arcs (L3 stored reversed); the
// hole wall carries a seam edge.
const PLATE = {
  bodyId: 'b1',
  faces: [
    { faceId: 'f_top', triStart: 0, triEnd: 10 },
    { faceId: 'f_hole', triStart: 10, triEnd: 20 },
    { faceId: 'f_side', triStart: 20, triEnd: 30 },
    { faceId: 'f_round', triStart: 30, triEnd: 40 },
  ],
  edges: [
    edge('L1', [[-8, -10, 10], [8, -10, 10]], ['f_top', 'f_side']),
    edge('A1', arc(8, -8, 2, -Q, 0, 10), ['f_top', 'f_round']),
    edge('L2', [[10, -8, 10], [10, 8, 10]], ['f_top', 'f_side']),
    edge('A2', arc(8, 8, 2, 0, Q, 10), ['f_top', 'f_round']),
    edge('L3', [[-8, 10, 10], [8, 10, 10]], ['f_top', 'f_side']),
    edge('A3', arc(-8, 8, 2, Q, 2 * Q, 10), ['f_top', 'f_round']),
    edge('L4', [[-10, 8, 10], [-10, -8, 10]], ['f_top', 'f_side']),
    edge('A4', arc(-8, -8, 2, 2 * Q, 3 * Q, 10), ['f_top', 'f_round']),
    // Vertical edge where the corner round meets a side: meets the top
    // outline at 90°.
    edge('V1', [[10, -8, 10], [10, -8, 0]], ['f_side', 'f_round']),
    edge('rim_top', arc(0, 0, 3, 0, 4 * Q, 10, 32), ['f_top', 'f_hole']),
    edge('rim_bottom', arc(0, 0, 3, 0, 4 * Q, 0, 32), ['f_hole', 'f_bottom']),
    edge('seam', [[3, 0, 10], [3, 0, 0]], ['f_hole', 'f_hole']),
  ],
} as unknown as TopologyMap;

const ids = (edges: { edgeId: unknown }[]) => edges.map(e => String(e.edgeId));
const OUTLINE = ['L1', 'A1', 'L2', 'A2', 'L3', 'A3', 'L4', 'A4'];

describe('edgeMatchesFaceFilter', () => {
  it('adjacentToFaceIds matches either side', () => {
    const f = { adjacentToFaceIds: new Set(['f_round']) };
    expect(edgeMatchesFaceFilter(['f_top', 'f_round'], f)).toBe(true);
    expect(edgeMatchesFaceFilter(['f_round', 'f_side'], f)).toBe(true);
    expect(edgeMatchesFaceFilter(['f_top', 'f_side'], f)).toBe(false);
  });

  it('betweenFaces is an exact unordered pair', () => {
    const f = { betweenFaces: ['f_side', 'f_top'] as const };
    expect(edgeMatchesFaceFilter(['f_top', 'f_side'], f)).toBe(true);
    expect(edgeMatchesFaceFilter(['f_top', 'f_round'], f)).toBe(false);
    expect(edgeMatchesFaceFilter(['f_top', 'f_top'], { betweenFaces: ['f_top', 'f_side'] })).toBe(false);
  });

  it('an empty filter matches everything', () => {
    expect(edgeMatchesFaceFilter(['a', 'b'], {})).toBe(true);
  });
});

describe('faceBoundaryEdges', () => {
  it('returns every edge of the face in topology order', () => {
    expect(ids(faceBoundaryEdges(PLATE, 'f_top'))).toEqual([...OUTLINE, 'rim_top']);
  });

  it('leaves out seam edges', () => {
    expect(isSeamEdge(PLATE.edges.find(e => String(e.edgeId) === 'seam')!)).toBe(true);
    expect(ids(faceBoundaryEdges(PLATE, 'f_hole'))).toEqual(['rim_top', 'rim_bottom']);
  });

  it('is empty for an unknown face', () => {
    expect(faceBoundaryEdges(PLATE, 'nope')).toEqual([]);
  });
});

describe('tangentChain', () => {
  it('follows lines and arcs round a rounded outline, either stored direction', () => {
    const chain = ids(tangentChain(PLATE, 'L1'));
    expect(chain[0]).toBe('L1');
    expect([...chain].sort()).toEqual([...OUTLINE].sort());
  });

  it('starting from an arc reaches the same chain', () => {
    expect([...ids(tangentChain(PLATE, 'A3'))].sort()).toEqual([...OUTLINE].sort());
  });

  it('stops at sharp corners', () => {
    expect(ids(tangentChain(PLATE, 'V1'))).toEqual(['V1']);
  });

  it('a closed edge with no tangent neighbour is its own chain', () => {
    expect(ids(tangentChain(PLATE, 'rim_top'))).toEqual(['rim_top']);
  });

  it('never chains seams, and an unknown seed is empty', () => {
    expect(ids(tangentChain(PLATE, 'seam'))).toEqual(['seam']);
    expect(tangentChain(PLATE, 'nope')).toEqual([]);
  });

  it('a polygon corner past the tolerance does not chain', () => {
    // Two segments meeting at 20° — a coarse polygon, not a tangent join.
    const a = 20 * Math.PI / 180;
    const topo = {
      bodyId: 'b',
      faces: [],
      edges: [
        edge('p1', [[-1, 0, 0], [0, 0, 0]], ['f1', 'f2']),
        edge('p2', [[0, 0, 0], [Math.cos(a), Math.sin(a), 0]], ['f1', 'f3']),
      ],
    } as unknown as TopologyMap;
    expect(ids(tangentChain(topo, 'p1'))).toEqual(['p1']);
    expect(ids(tangentChain(topo, 'p1', 0.4))).toEqual(['p1', 'p2']);
  });
});
