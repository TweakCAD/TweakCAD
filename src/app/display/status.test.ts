import { describe, expect, it } from 'vitest';
import { progressShare, statusOf } from './status';

describe('progressShare', () => {
  it("takes the worker's fraction when it tells one", () => {
    const s = statusOf({
      phase: 'building',
      done: 1,
      total: 3,
      kept: 0,
      part: 'p',
      feature: 'f',
      name: 'E',
      type: 'core.extrude',
      fraction: 0.4,
    });
    expect(progressShare(s)).toBe(0.4);
  });

  it('goes by counts otherwise, building most of the way and meshing the rest', () => {
    const b = statusOf({
      phase: 'building',
      done: 5,
      total: 10,
      kept: 0,
      part: 'p',
      feature: 'f',
      name: 'E',
      type: 'core.extrude',
    });
    expect(progressShare(b)).toBeCloseTo(0.45);
    expect(progressShare(statusOf({ phase: 'placing' }))).toBeCloseTo(0.9);
    expect(progressShare(statusOf({ phase: 'meshing', done: 1, total: 2 }))).toBeCloseTo(0.95);
  });

  it('tells nothing without counts', () => {
    expect(progressShare(statusOf({ phase: 'reading' }))).toBeNull();
    expect(progressShare(null)).toBeNull();
    expect(progressShare({ label: 'Checking sketches', done: 5, total: 40 })).toBeCloseTo(0.125);
  });
});
