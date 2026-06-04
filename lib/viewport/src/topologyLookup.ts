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
