import { describe, expect, it } from 'vitest';
import { detectRegions } from './detect';
import { drawn, SketchBuilder } from './fixtures';
import { regionSamplePoint, sideOfKey } from './sides';

const text = (id: string) => JSON.stringify({ drawn: { id } });

describe('sample points', () => {
  it('takes the middle of the bounding box when it lies inside', () => {
    const detection = detectRegions(new SketchBuilder().rectangle('r', 0, 0, 10, 4).build());
    const p = regionSamplePoint(detection.arrangement, detection.regions[0]!);
    expect(p![0]).toBeCloseTo(5, 6);
    expect(p![1]).toBeCloseTo(2, 6);
  });

  it('moves on along the sequence, x fastest, when the middle is in a hole', () => {
    const detection = detectRegions(new SketchBuilder().rectangle('r', 0, 0, 8, 8).circle('c', 4, 4, 1).build());
    const ring = detection.regions.find((r) => r.holes.set.length === 1)!;
    const p = regionSamplePoint(detection.arrangement, ring);
    expect(p![0]).toBeCloseTo(2, 6);
    expect(p![1]).toBeCloseTo(4, 6);
  });

  it('finds a thin region', () => {
    const detection = detectRegions(new SketchBuilder().rectangle('r', 0, 0, 1000, 0.01).build());
    expect(regionSamplePoint(detection.arrangement, detection.regions[0]!)).not.toBeNull();
  });
});

describe('sides of a curve', () => {
  const sketch = new SketchBuilder().segment('l', [0, 0], [10, 0]).circle('c', 50, 0, 5).build();
  const { arrangement } = detectRegions(sketch);

  it('gives +1 to the left of an open curve', () => {
    expect(sideOfKey(arrangement, text('l'), [5, 1])).toBe(1);
    expect(sideOfKey(arrangement, text('l'), [5, -1])).toBe(-1);
  });

  it('reads past an end by the direction there', () => {
    expect(sideOfKey(arrangement, text('l'), [12, 1])).toBe(1);
    expect(sideOfKey(arrangement, text('l'), [-2, -1])).toBe(-1);
  });

  it('gives +1 outside and -1 inside a closed curve', () => {
    expect(sideOfKey(arrangement, text('c'), [50, 1])).toBe(-1);
    expect(sideOfKey(arrangement, text('c'), [60, 0])).toBe(1);
  });

  it('gives nothing on the curve', () => {
    expect(sideOfKey(arrangement, text('l'), [5, 0])).toBeNull();
    expect(sideOfKey(arrangement, text('c'), [55, 0])).toBeNull();
  });

  it('gives nothing when equally near stretches disagree', () => {
    const fork = new SketchBuilder().segment('a', [0, 0], [10, 10], 'w').segment('b', [0, 0], [10, -10], 'w').build();
    const found = detectRegions(fork).arrangement;
    expect(sideOfKey(found, JSON.stringify(drawn('w')), [5, 0])).toBeNull();
  });
});
