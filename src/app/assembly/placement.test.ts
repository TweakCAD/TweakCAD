import { describe, expect, it } from 'vitest';
import {
  anglesOf,
  anglesOfRotationText,
  parseTriple,
  placementOf,
  quaternionFromAngles,
  readPlacementText,
  rotationText,
  tidy,
} from './placement';

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 9));

describe('placement fields', () => {
  it('reads back the angles a rotation was made from', () => {
    for (const angles of [
      [0, 0, 0],
      [90, 0, 0],
      [0, 45, 0],
      [0, 0, -30],
      [10, 20, 30],
      [-120, 35, 170],
    ] as [number, number, number][]) {
      close(anglesOf(quaternionFromAngles(...angles)), angles);
    }
  });

  it('turns about X, then the turned Y, then the turned Z', () => {
    // 90° about Z alone is the quaternion of a quarter turn about Z.
    close(quaternionFromAngles(0, 0, 90), [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    close(placementOf([1, 2, 3], [90, 0, 0]).rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  });

  it('keeps the rotation at a pole, where the numbers may differ', () => {
    const q = quaternionFromAngles(30, 90, 20);
    const back = quaternionFromAngles(...anglesOf(q));
    const dot = q.reduce((s, v, i) => s + v * (back[i] as number), 0);
    expect(Math.abs(dot)).toBeCloseTo(1, 9);
  });

  it('writes a rotation as one turn about an axis and reads it back', () => {
    expect(rotationText([0, 0, 0])).toBe('rotate(vector(0, 0, 1), 0 deg)');
    expect(rotationText([0, 0, 90])).toBe('rotate(vector(0, 0, 1), 90 deg)');
    close(anglesOfRotationText(rotationText([10, 20, 30])) ?? [], [10, 20, 30]);
    close(anglesOfRotationText('rotate(vector(0, 0, 1), 0 deg)') ?? [], [0, 0, 0]);
    expect(anglesOfRotationText('rotate(vector(0, 0, 1), turn)')).toBeNull();
  });

  it('splits a placement expression into its translation and rotation', () => {
    expect(readPlacementText('placement(vector(1 mm, w / 2, 0 mm), rotate(vector(0, 0, 1), 0 deg))')).toEqual({
      position: ['1 mm', 'w / 2', '0 mm'],
      rotation: 'rotate(vector(0, 0, 1), 0 deg)',
    });
    expect(readPlacementText('frameOf(x)')).toBeNull();
  });

  it('parses fields and shows numbers without noise', () => {
    expect(parseTriple(['1', '-2.5', '0'])).toEqual([1, -2.5, 0]);
    expect(parseTriple(['1', '', '0'])).toBeNull();
    expect(parseTriple(['1', 'x', '0'])).toBeNull();
    expect(tidy(89.99999999999999)).toBe('90');
    expect(tidy(-0)).toBe('0');
  });
});
