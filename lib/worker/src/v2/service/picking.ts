/** Reading the pick tables of a body mesh, and placements as matrices, for the viewport. */
import type { BodyMesh, Key, Placement } from './types';

/** The key in a `[first, count, key]` table whose range holds `index`. */
function lookup(table: Uint32Array, index: number): Key | undefined {
  let lo = 0;
  let hi = table.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const first = table[3 * mid] as number;
    const count = table[3 * mid + 1] as number;
    if (index < first) hi = mid - 1;
    else if (index >= first + count) lo = mid + 1;
    else return table[3 * mid + 2];
  }
  // Ranges are sorted by their first index; an empty range never holds one.
  return undefined;
}

/** The face a raycast hit, by the triangle's index in the mesh. */
export function faceAt(mesh: BodyMesh, triangle: number): Key | undefined {
  return lookup(mesh.faces, triangle);
}

/** The edge a line pick hit, by the segment's index. */
export function edgeAt(mesh: BodyMesh, segment: number): Key | undefined {
  return lookup(mesh.edges, segment);
}

/** A placement as a 4×4 matrix in column-major order, as WebGL and three.js take it. */
export function matrixOf(p: Placement): number[] {
  const [x, y, z, w] = p.rotation;
  const [tx, ty, tz] = p.position;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
