import { describe, expect, it } from 'vitest';
import { sampleSequence } from './facts';

const first = (dimensions: 2 | 3, n: number) => {
  const out: (readonly number[])[] = [];
  for (const p of sampleSequence(dimensions)) {
    out.push(p);
    if (out.length === n) break;
  }
  return out;
};

describe('sampleSequence', () => {
  it('starts at the centre, then takes level 2 tuples with the first coordinate fastest', () => {
    expect(first(2, 9)).toEqual([
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.5, 0.75],
      [0.25, 0.75],
      [0.75, 0.75],
    ]);
  });

  it('never repeats a point', () => {
    const points = first(3, 2000).map((p) => p.join(','));
    expect(new Set(points).size).toBe(points.length);
    expect(points[0]).toBe('0.5,0.5,0.5');
  });
});
