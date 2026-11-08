import { describe, expect, it } from 'vitest';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { newPrimitiveForm, type PrimitiveForm, type PrimitiveShape } from './primitive';
import { baseOutline, drawnBase, heightArrow, nextClick, placedByFirst } from './primitiveDraw';

const form = (shape: PrimitiveShape, patch: Partial<PrimitiveForm> = {}): PrimitiveForm => ({
  ...newPrimitiveForm(shape),
  drawing: true,
  ...patch,
});

describe('drawing a primitive base', () => {
  it('fills a box from two corners: width along x, depth along y, centred between them, standing on the plane', () => {
    const patch = drawnBase(form('box'), [10, -5], [-20.004, 15]);
    expect(patch).toMatchObject({ x: '-5', y: '5', z: '10', drawing: false });
    expect(patch?.dims).toMatchObject({ width: '30', depth: '20', height: '20' });
  });

  it('takes the centre, then the distance to the second click, as the radius', () => {
    expect(drawnBase(form('cylinder'), [5, 5], [8, 9])).toMatchObject({
      x: '5',
      y: '5',
      z: '10',
      dims: { radius: '5', height: '20' },
    });
    expect(drawnBase(form('cone'), [0, 0], [0, 7.5])).toMatchObject({
      dims: { bottomRadius: '7.5', topRadius: '0' },
      z: '10',
    });
    expect(drawnBase(form('sphere'), [1, 2], [4, 6])).toMatchObject({ x: '1', y: '2', z: '0', dims: { radius: '5' } });
    expect(drawnBase(form('torus'), [0, 0], [30, 0])).toMatchObject({
      z: '0',
      dims: { majorRadius: '30', minorRadius: '5' },
    });
  });

  it('does not take a second click on the first, or a box with no width or depth', () => {
    expect(drawnBase(form('cylinder'), [5, 5], [5.001, 5])).toBeNull();
    expect(drawnBase(form('box'), [0, 0], [10, 0])).toBeNull();
  });

  it('places by the first click when the sizes are typed instead', () => {
    expect(
      placedByFirst(form('box', { dims: { ...newPrimitiveForm('box').dims, width: '40', depth: '10' } }), [5, 5]),
    ).toEqual({ x: '25', y: '10' });
    expect(placedByFirst(form('cylinder'), [5, -3])).toEqual({ x: '5', y: '-3' });
  });

  it('outlines the base from the first click to the pointer', () => {
    expect(baseOutline('box', [0, 0], [10, 5])).toEqual([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ]);
    const circle = baseOutline('cylinder', [1, 1], [4, 5], 8);
    expect(circle).toHaveLength(8);
    for (const p of circle) expect(Math.hypot(p[0] - 1, p[1] - 1)).toBeCloseTo(5);
  });

  it('says what to click next', () => {
    expect(nextClick('box', null)).toBe('Click the first corner');
    expect(nextClick('box', [0, 0])).toBe('Click the opposite corner');
    expect(nextClick('cylinder', null)).toBe('Click the centre');
  });
});

describe('the height arrow', () => {
  const frame: FrameDisplay = { origin: [0, 0, 5], x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] };

  it('stands on top of a primitive standing on its plane, along the plane normal', () => {
    const box = { ...newPrimitiveForm('box'), x: '3', y: '2' };
    expect(heightArrow(box, frame)).toEqual({ at: [3, 20, 3], direction: [0, 1, 0], distance: 20 });
  });

  it('is absent for a sphere, a torus, or a primitive raised off its plane', () => {
    expect(heightArrow(newPrimitiveForm('sphere'), frame)).toBeNull();
    expect(heightArrow(newPrimitiveForm('torus'), frame)).toBeNull();
    expect(heightArrow({ ...newPrimitiveForm('box'), z: '40' }, frame)).toBeNull();
  });
});
