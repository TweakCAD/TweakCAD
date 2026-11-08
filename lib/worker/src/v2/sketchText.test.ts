import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentHash } from '@tweakcad/format';
import { FeaturePause } from './context';
import { capHeight, fontOf, glyphContours, layoutText } from './sketchText';

const here = dirname(fileURLToPath(import.meta.url));
// Lilita One, under the SIL Open Font License (its licence text sits next to the file).
const bytes = new Uint8Array(readFileSync(resolve(here, '../../../../src/assets/fonts/LilitaOne-Regular.ttf')));
const font = fontOf(contentHash(bytes), bytes);

describe('sketch text layout', () => {
  it('numbers glyphs by character, spaces included, and contours in the font order', () => {
    const curves = layoutText(font, 'txt_a', 'T O', 10, { origin: [0, 0], angle: 0 });
    const keys = curves.map((c) => ('glyph' in c.key ? [c.key.glyph.glyph, c.key.glyph.contour] : []));
    expect(keys).toEqual([
      [0, 0],
      [2, 0],
      [2, 1],
    ]);
  });

  it('closes each contour, starting it at the font’s first on-curve point', () => {
    // This O has no explicit on-curve point: each contour starts at the one implied between its first two points.
    const glyph = font.charToGlyph('O');
    const contours = glyphContours(font, glyph);
    const [a, b] = glyph.points!;
    expect(a!.onCurve || b!.onCurve).toBe(false);
    expect(contours[0]![0]![0]).toEqual([(a!.x + b!.x) / 2, (a!.y + b!.y) / 2]);
    // H's first point is on the curve.
    const h = font.charToGlyph('H');
    const [h0] = glyphContours(font, h);
    expect(h.points![0]!.onCurve).toBe(true);
    expect(h0![0]![0]).toEqual([h.points![0]!.x, h.points![0]!.y]);
    for (const segments of contours) {
      expect(segments.length).toBeGreaterThan(2);
      segments.forEach((s, i) => {
        const next = segments[(i + 1) % segments.length]!;
        expect(s[s.length - 1]).toEqual(next[0]);
        // TrueType outlines are lines and quadratics.
        expect([2, 3]).toContain(s.length);
      });
    }
  });

  it('makes the cap height the size, placed and turned by the frame', () => {
    const k = 10 / capHeight(font);
    const [plain] = layoutText(font, 'txt_a', 'H', 10, { origin: [0, 0], angle: 0 });
    const [moved] = layoutText(font, 'txt_a', 'H', 10, { origin: [5, 1], angle: Math.PI / 2 });
    if (plain?.shape.kind !== 'contour' || moved?.shape.kind !== 'contour') throw new Error('no contour');
    // The font declares its cap height; its H stands a little lower.
    expect(capHeight(font)).toBe(704);
    const hTop = Math.max(
      ...glyphContours(font, font.charToGlyph('H'))
        .flat(2)
        .map((p) => p[1]),
    );
    const top = Math.max(...plain.shape.segments.flat().map((p) => p[1]));
    expect(top).toBeCloseTo(hTop * k, 9);
    const [p, q] = [plain.shape.segments[0]![0]!, moved.shape.segments[0]![0]!];
    expect(q[0]).toBeCloseTo(5 - p[1], 9);
    expect(q[1]).toBeCloseTo(1 + p[0], 9);
  });

  it('pauses on line breaks and on characters the font has no glyph for', () => {
    expect(() => layoutText(font, 'txt_a', 'A\nB', 10, { origin: [0, 0], angle: 0 })).toThrow(FeaturePause);
    expect(() => layoutText(font, 'txt_a', 'A一', 10, { origin: [0, 0], angle: 0 })).toThrow(/no glyph/);
  });
});
