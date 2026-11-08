/**
 * Box, cylinder, sphere and torus features. Each opens with the operation, a
 * box and a cylinder after a flag byte. A placement record holds the plane it
 * was drawn on, and the feature's own rigid matrix where it stands on that
 * plane, which one at the plane's origin leaves out. Sizes are the feature's
 * own parameters.
 */
import type { DesignIndex } from './designIndex';
import { primaryRange, readPrologue, refsIn, type RecordRange } from './designIndex';
import { rigidMatrixAt } from './components';
import type { F3dExtrude, F3dParameter, F3dPrimitive } from './types';

const TYPE_PLACEMENT = '7B6C3C2D';
const MATRIX_BYTES = 128;
const AT_THE_ORIGIN = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const SHAPES: Record<string, F3dPrimitive['shape']> = {
  F193B033: 'box',
  '6AA4C36C': 'cylinder',
  '04A353F2': 'sphere',
  '13BE0EF0': 'torus',
};

export function readPrimitives(
  index: DesignIndex,
  operations: Record<number, F3dExtrude['operation']>,
  ownedBy: (id: number) => readonly F3dParameter[],
): { primitives: F3dPrimitive[]; unread: number } {
  const view = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  const matrixIn = (range: RecordRange | undefined): number[] | null => {
    if (range) {
      for (let p = range.start; p + MATRIX_BYTES <= range.end; p++) {
        const found = rigidMatrixAt(view, p);
        if (found) return found;
      }
    }
    return null;
  };
  const primitives: F3dPrimitive[] = [];
  let unread = 0;
  for (const [key, shape] of Object.entries(SHAPES)) {
    for (const id of index.idsOf.get(key) ?? []) {
      const range = primaryRange(index, id);
      const flag = shape === 'box' || shape === 'cylinder' ? 1 : 0;
      const operation = range ? operations[view.getUint32(readPrologue(index, range).next + flag, true)] : undefined;
      const holder = range
        ? refsIn(index, range.start, range.end).find((r) => index.typeOf.get(r.id)?.key === TYPE_PLACEMENT)
        : undefined;
      const plane = holder ? matrixIn(primaryRange(index, holder.id)) : null;
      const onPlane = matrixIn(range) ?? AT_THE_ORIGIN;
      if (!operation || !plane) {
        unread++;
        continue;
      }
      const sizes: Record<string, F3dParameter> = {};
      for (const p of ownedBy(id)) sizes[p.role] = p;
      primitives.push({ kind: 'primitive', id, shape, operation, plane, onPlane, sizes });
    }
  }
  return { primitives, unread };
}
