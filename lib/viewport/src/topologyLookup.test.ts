import { describe, expect, it } from 'vitest';
import { triangleToFaceId, segmentToEdgeId, faceMeshPlane } from './topologyLookup.ts';
import type { TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import { bodyId, faceId, edgeId } from '@tweakcad/core/src/ids.ts';

function makeFacesMap(): TopologyMap {
  return {
    bodyId: bodyId('b'),
    // 3 faces, in ascending triStart order, half-open ranges [start, end).
    faces: [
      { faceId: faceId('f0'), triStart: 0, triEnd: 4 },   // tris 0,1,2,3
      { faceId: faceId('f1'), triStart: 4, triEnd: 10 },  // tris 4..9
      { faceId: faceId('f2'), triStart: 10, triEnd: 11 }, // tri 10 only
    ],
    edges: [],
  };
}

describe('triangleToFaceId', () => {
  const map = makeFacesMap();

  it('finds the first face for triangles in its range', () => {
    expect(triangleToFaceId(0, map)).toBe('f0');
    expect(triangleToFaceId(3, map)).toBe('f0');
  });

  it('finds the middle face for triangles in its range', () => {
    expect(triangleToFaceId(4, map)).toBe('f1');
    expect(triangleToFaceId(9, map)).toBe('f1');
  });

  it('finds the last face for triangles in its range', () => {
    expect(triangleToFaceId(10, map)).toBe('f2');
  });

  it('returns null for indices past the last face', () => {
    expect(triangleToFaceId(11, map)).toBeNull();
    expect(triangleToFaceId(99, map)).toBeNull();
  });

  it('returns null for empty topology', () => {
    const empty: TopologyMap = { bodyId: bodyId('b'), faces: [], edges: [] };
    expect(triangleToFaceId(0, empty)).toBeNull();
  });

  it('returns null for undefined topology', () => {
    expect(triangleToFaceId(0, undefined)).toBeNull();
  });

  it('returns null for negative or non-integer indices', () => {
    expect(triangleToFaceId(-1, map)).toBeNull();
    expect(triangleToFaceId(0.5, map)).toBeNull();
    expect(triangleToFaceId(NaN, map)).toBeNull();
  });

  it('respects half-open ranges: triEnd is exclusive', () => {
    // f0 covers [0..4); index 4 belongs to f1, not f0.
    expect(triangleToFaceId(4, map)).toBe('f1');
  });
});

describe('segmentToEdgeId', () => {
  function makeEdges(segmentCounts: number[]): TopologyMap {
    return {
      bodyId: bodyId('b'),
      faces: [],
      edges: segmentCounts.map((n, i) => ({
        edgeId: edgeId(`e${i}`),
        // 6 floats per segment: (x1,y1,z1, x2,y2,z2). Just allocate length.
        lineSegments: new Float32Array(n * 6),
        adjacentFaces: [faceId('f0'), faceId('f1')],
      })),
    };
  }

  it('maps segments to their owning edge', () => {
    // e0 has 2 segments, e1 has 3, e2 has 1. Total 6 segments.
    const map = makeEdges([2, 3, 1]);
    expect(segmentToEdgeId(0, map)).toBe('e0');
    expect(segmentToEdgeId(1, map)).toBe('e0');
    expect(segmentToEdgeId(2, map)).toBe('e1');
    expect(segmentToEdgeId(3, map)).toBe('e1');
    expect(segmentToEdgeId(4, map)).toBe('e1');
    expect(segmentToEdgeId(5, map)).toBe('e2');
  });

  it('returns null past the last segment', () => {
    const map = makeEdges([2, 3, 1]);
    expect(segmentToEdgeId(6, map)).toBeNull();
    expect(segmentToEdgeId(100, map)).toBeNull();
  });

  it('returns null for empty edges', () => {
    const empty: TopologyMap = { bodyId: bodyId('b'), faces: [], edges: [] };
    expect(segmentToEdgeId(0, empty)).toBeNull();
  });

  it('returns null for undefined topology', () => {
    expect(segmentToEdgeId(0, undefined)).toBeNull();
  });

  it('returns null for negative or non-integer indices', () => {
    const map = makeEdges([2]);
    expect(segmentToEdgeId(-1, map)).toBeNull();
    expect(segmentToEdgeId(0.5, map)).toBeNull();
  });
});

describe('faceMeshPlane', () => {
  // A unit square at y = 5 (two triangles wound so the normal is +Y),
  // then a 90° bend down the side x = 1 (two more triangles).
  const positions = new Float32Array([
    0, 5, 0,   0, 5, 1,   1, 5, 1,   1, 5, 0,
    1, 4, 0,   1, 4, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,   0, 2, 3,   // top, +Y
    3, 2, 5,   3, 5, 4,   // side, +X
  ]);

  it('returns the plane of a flat face, oriented by its winding', () => {
    const plane = faceMeshPlane(positions, indices, 0, 2);
    expect(plane).not.toBeNull();
    expect(plane!.normal[0]).toBeCloseTo(0, 9);
    expect(plane!.normal[1]).toBeCloseTo(1, 9);
    expect(plane!.normal[2]).toBeCloseTo(0, 9);
    expect(plane!.point[1]).toBe(5);
  });

  it('rejects a face whose triangles do not share one plane', () => {
    expect(faceMeshPlane(positions, indices, 0, 4)).toBeNull();
  });

  it('rejects an empty or degenerate range', () => {
    expect(faceMeshPlane(positions, indices, 2, 2)).toBeNull();
    expect(faceMeshPlane(new Float32Array(9), new Uint32Array([0, 1, 2]), 0, 1)).toBeNull();
  });
});
