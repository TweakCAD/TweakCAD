import { describe, expect, it } from 'vitest';
import { touching } from './loft';

const faces = (list: { face: number; ordinal: number }[]) => list.map((t) => [t.face, t.ordinal]);

describe('the faces a section edge touches', () => {
  it('are all of them on a smooth loft, numbered along the edge', () => {
    expect(faces(touching([7, 8, 9], 1, 2, false, false))).toEqual([
      [7, 0],
      [8, 1],
      [9, 2],
    ]);
  });

  it('are the pairs on each side of a section on a ruled loft', () => {
    const list = [1, 2, 3, 4, 5, 6];
    expect(faces(touching(list, 0, 3, true, false))).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(faces(touching(list, 1, 3, true, false))).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 1],
    ]);
    expect(faces(touching(list, 3, 3, true, false))).toEqual([
      [5, 0],
      [6, 1],
    ]);
  });

  it('wrap round the first section of a closed ruled loft', () => {
    expect(faces(touching([1, 2, 3], 0, 3, true, true))).toEqual([
      [1, 0],
      [3, 0],
    ]);
    expect(faces(touching([1, 2, 3], 2, 3, true, true))).toEqual([
      [2, 0],
      [3, 0],
    ]);
  });
});
