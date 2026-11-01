import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, type Font } from 'opentype.js';
import { SKETCH_FONTS } from './sketchFonts.ts';
import { textToPrimitives } from '@tweakcad/core/src/sketch/text/textOutline.ts';
import { buildEditorStateFromPrimitives, type DxfPrimitive } from '@tweakcad/core/src/sketch/io/dxfImport.ts';
import { assignHoles, detectSketchRegions } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { editorModelToBuildGeometry } from '@tweakcad/core/src/sketch/serialization.ts';

function loadFont(file: string): Font {
  const buf = readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));
  return parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

function regionsOf(prims: DxfPrimitive[]) {
  return assignHoles(detectSketchRegions(editorModelToBuildGeometry(buildEditorStateFromPrimitives(prims))));
}

/** Number of closed chains (each primitive starts where the previous ended). */
function loopCount(prims: DxfPrimitive[]): number {
  let loops = 0;
  let start: readonly [number, number] | null = null;
  for (const p of prims) {
    if (p.kind !== 'line' && p.kind !== 'bezier') throw new Error(`unexpected ${p.kind}`);
    if (!start) start = p.start;
    if (p.end[0] === start[0] && p.end[1] === start[1]) {
      loops++;
      start = null;
    }
  }
  expect(start).toBeNull();
  return loops;
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&?!';

describe.each(SKETCH_FONTS.map((f) => [f.label, f.file] as const))('%s', (_label, file) => {
  const font = loadFont(file);

  it('"ANNA" at 10 mm: four letters, the two A counters open', () => {
    const prims = textToPrimitives(font, 'ANNA', { height: 10, origin: [0, 0] });
    const ys = prims.flatMap((p) => (p.kind === 'line' || p.kind === 'bezier' ? [p.start[1]] : []));
    expect(Math.min(...ys)).toBeCloseTo(0, 1);
    expect(Math.max(...ys)).toBeGreaterThan(9.7);
    expect(Math.max(...ys)).toBeLessThan(10.3);

    const regions = regionsOf(prims);
    const holed = regions.filter((r) => (r.holes?.length ?? 0) > 0);
    const counters = new Set(holed.flatMap((r) => r.holes!.map((h) => h.id)));
    const letters = regions.filter((r) => !counters.has(r.id));
    expect(letters).toHaveLength(4);
    expect(holed).toHaveLength(2);
  });

  it('every glyph outline is closed loops that never cross', () => {
    for (const text of [...CHARS, 'AV', 'To', 'LT', 'WA', 'Ty', 'rn']) {
      const prims = textToPrimitives(font, text, { height: 10 });
      // Crossing or touching loops would split into extra regions.
      expect(regionsOf(prims).length, text).toBe(loopCount(prims));
    }
  });
});
