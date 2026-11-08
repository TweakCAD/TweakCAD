import { describe, expect, it } from 'vitest';
import { newMoveForm } from './bodyFeatures';
import { eulerOf, turnOfEuler, turnRows } from './MoveBodiesPanel';

describe('move turn as Euler angles', () => {
  it('reads an axis and angle as Euler X, Y, Z degrees', () => {
    expect(eulerOf({ ...newMoveForm(), axis: ['0', '0', '1'], angle: '90' })).toEqual(['0', '0', '90']);
    expect(eulerOf({ ...newMoveForm(), axis: ['1', '0', '0'], angle: '30' })).toEqual(['30', '0', '0']);
    expect(eulerOf({ ...newMoveForm(), angle: 'a + 1' })).toBeNull();
  });

  it('writes Euler degrees back as an axis and angle that read the same', () => {
    expect(turnOfEuler(['0', '45', '0'])).toEqual({ axis: ['0', '1', '0'], angle: '45' });
    const turn = turnOfEuler(['10', '20', '30']);
    expect(turn && eulerOf({ ...newMoveForm(), ...turn })).toEqual(['10', '20', '30']);
    expect(turnOfEuler(['10', 'x', '0'])).toBeNull();
  });
});

describe('the Move panel turn fields', () => {
  it('shows one set: X, Y, Z angles for a plain turn, the angle and axis for one written with expressions', () => {
    expect(turnRows({ ...newMoveForm(), axis: ['0', '0', '1'], angle: '30' })).toBe('euler');
    expect(turnRows({ ...newMoveForm(), axis: ['0', '0', '1'], angle: 'turn * 2' })).toBe('axisAngle');
  });
});
