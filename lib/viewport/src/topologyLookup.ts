/**
 * Pure topology lookup helpers.
 *
 * Three.js's Raycaster.intersectObject returns hits with a `.faceIndex`
 * field — that's the index of the hit *triangle*, not the index buffer
 * offset. `TopologyMap.faces[i].triStart..triEnd` is the half-open range
 * of triangle indices belonging to face i. These functions binary-search
 * those ranges to map a hit back to its owning faceId / edgeId.
 *
 * Kept dependency-free for trivial unit testing.
 */

import type { TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import type { FaceId, EdgeId } from '@tweakcad/core/src/ids.ts';

/**
 * Map a hit triangle index to the FaceId of the face that owns it.
 *
 * @param triIdx     0-based triangle index (e.g., Three.js `intersection.faceIndex`).
 * @param topoMap    The body's topology map; `faces[].triStart..triEnd`
 *                   is treated as a half-open range.
 * @returns          The matching FaceId or null if no face owns this index.
 */
export function triangleToFaceId(
  triIdx: number,
  topoMap: TopologyMap | undefined,
): FaceId | null {
  if (!topoMap || !Number.isInteger(triIdx) || triIdx < 0) return null;
  const faces = topoMap.faces;
  if (faces.length === 0) return null;

  // Binary search: find the face where triStart <= triIdx < triEnd.
  // Assumes faces are stored in ascending triStart order (the worker
  // produces them that way during tessellation).
  let lo = 0;
  let hi = faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const f = faces[mid]!;
    if (triIdx < f.triStart) {
      hi = mid - 1;
    } else if (triIdx >= f.triEnd) {
      lo = mid + 1;
    } else {
      return f.faceId;
    }
  }
  return null;
}

/**
 * Map a hit line-segment index to the EdgeId of the edge that owns it.
 *
 * For edges, each `topoMap.edges[i].lineSegments` is a Float32Array of
 * vertex positions: 6 floats per segment (start xyz + end xyz). The
 * flattened layout when all edge segments are concatenated into a single
 * LineSegments geometry means a hit segment index `segIdx` belongs to the
 * edge whose cumulative segment count first exceeds `segIdx`.
 *
 * @param segIdx     0-based line-segment index in the concatenated buffer.
 * @param topoMap    The body's topology map.
 * @returns          The matching EdgeId or null if no edge owns this index.
 */
export function segmentToEdgeId(
  segIdx: number,
  topoMap: TopologyMap | undefined,
): EdgeId | null {
  if (!topoMap || !Number.isInteger(segIdx) || segIdx < 0) return null;
  const edges = topoMap.edges;
  if (edges.length === 0) return null;

  // Walk linearly: edge count is typically small (tens) so linear is fine.
  // Each edge contributes (lineSegments.length / 6) segments.
  let cursor = 0;
  for (const edge of edges) {
    const segCount = edge.lineSegments.length / 6;
    if (segIdx < cursor + segCount) {
      return edge.edgeId;
    }
    cursor += segCount;
  }
  return null;
}

/** A flat face's plane, read off its tessellation. */
export type MeshFacePlane = {
  /** Unit normal, oriented like the triangles' winding (outward). */
  normal: [number, number, number];
  /** A point on the plane (the first vertex of the face). */
  point: [number, number, number];
};

/**
 * The plane of the face covering triangles `[triStart, triEnd)` of an
 * indexed mesh, or null when the face isn't flat: some triangle tilts away
 * from the area-weighted normal, or a vertex sits off the plane by more than
 * `tolerance` mm. A tessellated cylinder fails both checks; a planar face
 * with holes passes.
 */
export function faceMeshPlane(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  triStart: number,
  triEnd: number,
  tolerance = 1e-3,
): MeshFacePlane | null {
  if (!(triEnd > triStart)) return null;
  const vert = (i: number): [number, number, number] => {
    const k = indices[i]! * 3;
    return [positions[k]!, positions[k + 1]!, positions[k + 2]!];
  };
  const triNormal = (t: number): [number, number, number] => {
    const a = vert(t * 3), b = vert(t * 3 + 1), c = vert(t * 3 + 2);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };

  let nx = 0, ny = 0, nz = 0;
  for (let t = triStart; t < triEnd; t++) {
    const n = triNormal(t);
    nx += n[0]; ny += n[1]; nz += n[2];
  }
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12)) return null;
  const normal: [number, number, number] = [nx / len, ny / len, nz / len];
  const point = vert(triStart * 3);
  const d = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2];

  for (let t = triStart; t < triEnd; t++) {
    const n = triNormal(t);
    const nLen = Math.hypot(n[0], n[1], n[2]);
    // Sliver triangles carry no reliable direction; the vertex check covers them.
    if (nLen > 1e-9 && (n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2]) / nLen < 0.9999) return null;
    for (let i = t * 3; i < t * 3 + 3; i++) {
      const p = vert(i);
      if (Math.abs(normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - d) > tolerance) return null;
    }
  }
  return { normal, point };
}
