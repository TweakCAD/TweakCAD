import { describe, expect, it } from 'vitest';
import { placeGlyphs, type ScreenSpot } from './glyphs';

const SIZE = 16;
const STEP = 18;

const overlapping = (spots: readonly ScreenSpot[]) =>
  spots.flatMap((a, i) =>
    spots
      .slice(i + 1)
      .filter((b) => Math.abs(a.x - b.x) < SIZE && Math.abs(a.y - b.y) < SIZE)
      .map((b) => [a, b]),
  );

describe('glyph badges on screen', () => {
  it('stand beside and below their anchors when there is room', () => {
    expect(
      placeGlyphs(
        [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
        ],
        SIZE,
        STEP,
      ),
    ).toEqual([
      { x: 106, y: 104 },
      { x: 306, y: 104 },
    ]);
  });

  it('stand apart where many crowd one spot or a small shape, the first in its own place', () => {
    const crowd = Array.from({ length: 12 }, () => ({ x: 200, y: 200 }));
    const small = Array.from({ length: 24 }, (_, i) => ({ x: 200 + 10 * Math.cos(i), y: 200 + 10 * Math.sin(i) }));
    for (const anchors of [crowd, small]) {
      const spots = placeGlyphs(anchors, SIZE, STEP);
      expect(spots[0]).toEqual({ x: (anchors[0] as ScreenSpot).x + 6, y: (anchors[0] as ScreenSpot).y + 4 });
      expect(overlapping(spots)).toEqual([]);
      // Each stays near its anchor.
      spots.forEach((p, i) =>
        expect(Math.hypot(p.x - (anchors[i] as ScreenSpot).x, p.y - (anchors[i] as ScreenSpot).y)).toBeLessThan(
          8 * STEP,
        ),
      );
    }
  });
});
