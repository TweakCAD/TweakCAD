import { describe, expect, it } from 'vitest';
import {
  ISO_METRIC,
  ISO_METRIC_DESIGNATIONS,
  ISO_METRIC_SIZES,
  isoDesignations,
  listedDesignation,
  threadSize,
} from './threadTable';

const H = (pitch: number) => (Math.sqrt(3) / 2) * pitch;

describe('the ISO metric table', () => {
  it('lists each size with its coarse designation first, then its fine ones, largest pitch first', () => {
    expect(isoDesignations(8)).toEqual(['M8', 'M8x1', 'M8x0.75']);
    expect(isoDesignations(12)).toEqual(['M12', 'M12x1.5', 'M12x1.25', 'M12x1']);
    expect(isoDesignations(42)).toEqual(['M42', 'M42x4', 'M42x3', 'M42x2', 'M42x1.5']);
    // Sizes that have fine pitches only.
    expect(isoDesignations(15)).toEqual(['M15x1.5', 'M15x1']);
    expect(isoDesignations(5.5)).toEqual(['M5.5x0.5']);
    expect(isoDesignations(7.5)).toEqual([]);
    expect(ISO_METRIC_SIZES).toContain(5.5);
    expect([...ISO_METRIC_SIZES]).toEqual([...ISO_METRIC_SIZES].sort((a, b) => a - b));
    expect(new Set(ISO_METRIC_DESIGNATIONS).size).toBe(ISO_METRIC_DESIGNATIONS.length);
  });

  it('builds a fine pitch on the ISO 68-1 profile', () => {
    const s = threadSize(ISO_METRIC, 'M8x1');
    expect(s).toMatchObject({ designation: 'M8x1', major: 8, pitch: 1, tapDrill: 7 });
    expect(s.pitchDiameter).toBeCloseTo(8 - 0.75 * H(1), 12);
    expect(s.minor).toBeCloseTo(8 - 1.25 * H(1), 12);
  });

  it('takes the coarse pitch written out as the coarse thread', () => {
    expect(threadSize(ISO_METRIC, 'M8x1.25')).toMatchObject({ pitch: 1.25, tapDrill: 6.8 });
    expect(listedDesignation('M8x1.25')).toBe('M8');
    expect(listedDesignation('M8x1')).toBe('M8x1');
    expect(listedDesignation('M8x0.5')).toBeNull();
  });

  it('drills fine threads as ISO 2306 gives them', () => {
    // The ISO 2306 drills a published chart lists (amesweb.info, metric tap drill chart).
    const published: [string, number][] = [
      ['M8x1', 7],
      ['M10x1', 9],
      ['M10x1.25', 8.8],
      ['M12x1.25', 10.8],
      ['M12x1.5', 10.5],
      ['M14x1.5', 12.5],
      ['M16x1.5', 14.5],
      ['M18x1.5', 16.5],
      ['M20x1.5', 18.5],
      ['M20x2', 18],
      ['M22x1.5', 20.5],
      ['M24x2', 22],
      ['M27x2', 25],
      ['M30x2', 28],
      ['M33x2', 31],
      ['M36x3', 33],
      ['M39x3', 36],
      ['M42x3', 39],
      ['M45x3', 42],
      ['M48x3', 45],
      ['M52x4', 48],
      ['M6x0.75', 5.2],
    ];
    for (const [designation, drill] of published)
      expect([designation, threadSize(ISO_METRIC, designation).tapDrill]).toEqual([designation, drill]);
  });

  it('drills the small and 0.75 mm pitches as DIN 336 rounds them', () => {
    // DIN 13 fine-thread table with DIN 336 drills (gewinde-norm.de): 0.75 mm pitch takes 0.8 off, 1.25 mm takes 1.2.
    const din: [string, number][] = [
      ['M2x0.25', 1.75],
      ['M2.5x0.35', 2.15],
      ['M3x0.35', 2.65],
      ['M4x0.5', 3.5],
      ['M5x0.5', 4.5],
      ['M7x0.75', 6.2],
      ['M8x0.75', 7.2],
      ['M10x0.75', 9.2],
      ['M14x1.25', 12.8],
      ['M15x1', 14],
      ['M25x1.5', 23.5],
      ['M36x2', 34],
    ];
    for (const [designation, drill] of din)
      expect([designation, threadSize(ISO_METRIC, designation).tapDrill]).toEqual([designation, drill]);
  });

  it('holds M17 with its two fine pitches and no coarse one', () => {
    expect(threadSize(ISO_METRIC, 'M17x1.5')).toMatchObject({ major: 17, pitch: 1.5, tapDrill: 15.5 });
    expect(threadSize(ISO_METRIC, 'M17x1')).toMatchObject({ major: 17, pitch: 1, tapDrill: 16 });
    expect(() => threadSize(ISO_METRIC, 'M17')).toThrow('M17 has no coarse pitch; give its pitch, as in "M17x1.5"');
  });

  it('drills every fine thread between its basic minor and major diameters', () => {
    for (const designation of ISO_METRIC_DESIGNATIONS) {
      const s = threadSize(ISO_METRIC, designation);
      expect(s.tapDrill, designation).toBeGreaterThanOrEqual(s.minor - 1e-9);
      expect(s.tapDrill, designation).toBeLessThan(s.major);
    }
  });

  it('pauses for a pitch or size it does not hold', () => {
    expect(() => threadSize(ISO_METRIC, 'M8x0.5')).toThrow('"M8x0.5" is not an ISO metric pitch of M8');
    expect(() => threadSize(ISO_METRIC, 'M15')).toThrow('M15 has no coarse pitch; give its pitch, as in "M15x1.5"');
    expect(() => threadSize(ISO_METRIC, 'M7.5')).toThrow('"M7.5" is not an ISO metric size');
    expect(() => threadSize(ISO_METRIC, '8x1')).toThrow('"8x1" is not an ISO metric size');
  });
});
