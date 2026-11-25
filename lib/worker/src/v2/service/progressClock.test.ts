import { describe, expect, it } from 'vitest';
import { ProgressClock } from './progressClock';
import type { Progress } from './types';

const building = (feature: string): Progress => ({
  phase: 'building',
  done: 0,
  total: 3,
  kept: 0,
  part: 'p',
  feature,
  name: feature,
  type: 'core.extrude',
});

function run(clock: ProgressClock, at: { t: number }) {
  const fractions: (number | undefined)[] = [];
  const step = (p: Progress, ms: number) => {
    const out = clock.report(p);
    fractions.push('fraction' in out ? out.fraction : undefined);
    at.t += ms;
  };
  step(building('a'), 10);
  step(building('b'), 80);
  step(building('c'), 10);
  step({ phase: 'meshing', done: 0, total: 2 }, 50);
  step({ phase: 'meshing', done: 1, total: 2 }, 50);
  return fractions;
}

describe('ProgressClock', () => {
  it('times each feature and meshing', () => {
    const at = { t: 0 };
    const clock = new ProgressClock(['p/a', 'p/b', 'p/c'], undefined, true, () => at.t);
    expect(run(clock, at)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(clock.finish(undefined)).toEqual({ features: { 'p/a': 10, 'p/b': 80, 'p/c': 10 }, meshing: 100 });
  });

  it('reports a full build in time from an earlier one', () => {
    const at = { t: 0 };
    const earlier = { features: { 'p/a': 10, 'p/b': 80, 'p/c': 10 }, meshing: 100 };
    const clock = new ProgressClock(['p/a', 'p/b', 'p/c'], earlier, true, () => at.t);
    // 200 ms in all: the slow feature b takes 40 % of it.
    expect(run(clock, at)).toEqual([0, 0.05, 0.45, 0.5, 0.75]);
  });

  it('reports no fraction for a build that resumes, or when few features were timed', () => {
    const at = { t: 0 };
    const earlier = { features: { 'p/a': 10, 'p/b': 80, 'p/c': 10 } };
    expect(run(new ProgressClock(['p/a', 'p/b', 'p/c'], earlier, false, () => at.t), at)).toEqual(
      Array(5).fill(undefined),
    );
    const few = { features: { 'p/a': 10 } };
    expect(run(new ProgressClock(['p/a', 'p/b', 'p/c'], few, true, () => at.t), at)).toEqual(Array(5).fill(undefined));
  });

  it('keeps the times of features it took over', () => {
    const at = { t: 0 };
    const clock = new ProgressClock(['p/a', 'p/b'], undefined, false, () => at.t);
    clock.report(building('b'));
    at.t += 7;
    expect(clock.finish({ features: { 'p/a': 3, 'p/b': 9 }, placing: 4 })).toEqual({
      features: { 'p/a': 3, 'p/b': 7 },
      placing: 4,
    });
  });
});
