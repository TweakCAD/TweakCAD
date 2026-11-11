import { describe, expect, it } from 'vitest';
import { shapeFingerprint } from './derived';
import { FakeKernel } from './fakeKernel';

/** Two edges between the same two vertices, the halves of a circle, listed in `order`. */
function halves(order: readonly number[]): FakeKernel {
  const k = new FakeKernel();
  const edges = [11, 12];
  k.trees.set('s', [
    { key: 1, kind: 'compound', children: order.map((i) => edges[i] as number) },
    ...order.map((i) => ({ key: edges[i] as number, kind: 'edge' as const, children: [21, 22] })),
    { key: 21, kind: 'vertex', children: [] },
    { key: 22, kind: 'vertex', children: [] },
  ]);
  k.points.set(21, [5, 0, 0]);
  k.points.set(22, [-5, 0, 0]);
  k.ranges.set(11, [0, Math.PI]);
  k.ranges.set(12, [Math.PI, 2 * Math.PI]);
  return k;
}

describe('the fingerprint of a stored shape', () => {
  it('is the same for the same numbering', () => {
    expect(shapeFingerprint('s', halves([0, 1]))).toBe(shapeFingerprint('s', halves([0, 1])));
  });

  it('tells apart two edges with the same vertices by their parameter ranges', () => {
    expect(shapeFingerprint('s', halves([1, 0]))).not.toBe(shapeFingerprint('s', halves([0, 1])));
  });

  it('changes when a vertex moves', () => {
    const moved = halves([0, 1]);
    moved.points.set(21, [5, 1e-12, 0]);
    expect(shapeFingerprint('s', moved)).not.toBe(shapeFingerprint('s', halves([0, 1])));
  });
});
