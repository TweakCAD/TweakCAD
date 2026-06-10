import { describe, it, expect } from 'vitest';
import { ringSelfIntersects } from './selfIntersection.ts';

describe('ringSelfIntersects', () => {
  it('returns false for a convex quad', () => {
    expect(ringSelfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false);
  });

  it('returns false for a non-convex but simple polygon', () => {
    // An arrowhead / chevron — concave but not self-crossing.
    expect(ringSelfIntersects([[0, 0], [10, 5], [0, 10], [3, 5]])).toBe(false);
  });

  it('detects a bow-tie (figure-eight) self-crossing', () => {
    // Classic self-intersecting quad: edges (0,0)-(10,10) and (10,0)-(0,10) cross.
    expect(ringSelfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true);
  });

  it('detects a crossing in a larger ring', () => {
    const ring: [number, number][] = [[0, 0], [10, 0], [10, 10], [5, 10], [5, -5], [0, 10]];
    expect(ringSelfIntersects(ring)).toBe(true);
  });

  it('returns false for a triangle (too few edges to cross)', () => {
    expect(ringSelfIntersects([[0, 0], [10, 0], [5, 10]])).toBe(false);
  });
});
