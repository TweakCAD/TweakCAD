import { describe, it, expect } from 'vitest';
import { catmullRomClosed } from './curveSampling.ts';
import { ringSelfIntersects } from './selfIntersection.ts';

describe('catmullRomClosed', () => {
  it('emits length*subdivisions points and starts at the first control point', () => {
    const ctrl: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const out = catmullRomClosed(ctrl, 8);
    expect(out).toHaveLength(4 * 8);
    expect(out[0]).toEqual([0, 0]); // span starts land on control points
  });

  it('does NOT repeat the first point at the end (periodic closure)', () => {
    const ctrl: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const out = catmullRomClosed(ctrl, 4);
    const first = out[0]!;
    const last = out[out.length - 1]!;
    expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeGreaterThan(0.1);
  });

  it('is seam-free: a gentle closed wave does not self-intersect', () => {
    // Regression: phantom-endpoint Catmull-Rom kinked at the wrap seam and
    // tripped the self-intersection guard on this exact shape. The periodic
    // version wraps neighbours, so the seam is smooth and the ring is simple.
    const ctrl: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      const rad = 25 + 4 * Math.cos(3 * a);
      ctrl.push([rad * Math.cos(a), rad * Math.sin(a)]);
    }
    const ring = catmullRomClosed(ctrl, 8);
    expect(ringSelfIntersects(ring)).toBe(false);
  });

  it('returns the points unchanged for fewer than 3 control points', () => {
    expect(catmullRomClosed([[0, 0], [1, 1]], 8)).toEqual([[0, 0], [1, 1]]);
  });
});
