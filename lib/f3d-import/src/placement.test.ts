import { describe, expect, it } from 'vitest';
import { compose, frameOfMatrix, invert, mm, numberText, placementOfFrame, placementText } from './placement';

describe('frameOfMatrix', () => {
  it('reads an absent matrix as the xy plane', () => {
    const f = frameOfMatrix(null);
    expect(f.normal).toEqual([0, 0, 1]);
    expect(f.origin).toEqual([0, 0, 0]);
  });

  it('gives the origin in millimetres', () => {
    const f = frameOfMatrix([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1]);
    expect(f.origin).toEqual([10, 20, 30]);
  });

  it('takes the normal from the x and y axes, whichever way the z axis points', () => {
    const f = frameOfMatrix([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(f.normal).toEqual([0, 0, -1]);
  });
});

describe('placements', () => {
  it('undoes a placement with its inverse', () => {
    const p = placementOfFrame([1, 2, 3], [0, 1, 0], [0, 0, 1]);
    const back = compose(p, invert(p));
    back.position.forEach((c) => expect(c).toBeCloseTo(0));
    expect(Math.abs(back.rotation[3])).toBeCloseTo(1);
  });

  it('writes a quarter turn about z', () => {
    expect(placementText(placementOfFrame([0, 0, 0], [0, 1, 0], [0, 0, 1]))).toBe(
      'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 90 deg))',
    );
  });
});

describe('numberText', () => {
  it('never writes an exponent', () => {
    expect(numberText(1.5e-7)).toBe('0.00000015');
  });

  it('snaps noise to a whole number', () => {
    expect(mm(39.9999999999)).toBe('40 mm');
  });
});
