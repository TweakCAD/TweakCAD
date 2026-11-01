import { describe, it, expect } from 'vitest';
import {
  capHeightUnits,
  outlineToPrimitives,
  textToPrimitives,
  type OutlineCommand,
  type OutlineFont,
} from './textOutline.ts';
import { buildEditorStateFromPrimitives, type DxfPrimitive } from '../io/dxfImport.ts';
import { assignHoles, detectSketchRegions, regionNetArea } from '../profileRegions.ts';
import { editorModelToBuildGeometry } from '../serialization.ts';
import { makeCounterIdFactory } from '../operations.ts';

const PLACE = { scale: 1, origin: [0, 0] as [number, number] };

/** Y-down square, 0..s, with an optional square counter inset by `inset`. */
function squareGlyph(s: number, x0 = 0, inset?: number): OutlineCommand[] {
  const loop = (a: number, b: number): OutlineCommand[] => [
    { type: 'M', x: x0 + a, y: -a },
    { type: 'L', x: x0 + b, y: -a },
    { type: 'L', x: x0 + b, y: -b },
    { type: 'L', x: x0 + a, y: -b },
    { type: 'Z' },
  ];
  return inset === undefined ? loop(0, s) : [...loop(0, s), ...loop(inset, s - inset)];
}

function regionsOf(prims: DxfPrimitive[]) {
  const state = buildEditorStateFromPrimitives(prims, { idFactory: makeCounterIdFactory() });
  return assignHoles(detectSketchRegions(editorModelToBuildGeometry(state)));
}

/** Every primitive's start equals the previous one's end, and each loop closes. */
function expectClosedChains(prims: DxfPrimitive[]): void {
  let loopStart: [number, number] | null = null;
  let prevEnd: [number, number] | null = null;
  for (const p of prims) {
    if (p.kind !== 'line' && p.kind !== 'bezier') throw new Error(`unexpected ${p.kind}`);
    if (prevEnd && (prevEnd[0] !== p.start[0] || prevEnd[1] !== p.start[1])) loopStart = null;
    if (!loopStart) loopStart = p.start;
    prevEnd = p.end;
    if (p.end[0] === loopStart[0] && p.end[1] === loopStart[1]) {
      loopStart = null;
      prevEnd = null;
    }
  }
  expect(loopStart).toBeNull();
}

describe('outlineToPrimitives', () => {
  it('flips Y-down glyph space to Y-up sketch space and places at the origin', () => {
    const prims = outlineToPrimitives(squareGlyph(10), { scale: 0.5, origin: [100, 20] });
    expect(prims).toHaveLength(4);
    const xs = prims.flatMap((p) => (p.kind === 'line' ? [p.start[0], p.end[0]] : []));
    const ys = prims.flatMap((p) => (p.kind === 'line' ? [p.start[1], p.end[1]] : []));
    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(105);
    // Glyph y in [-10, 0] (above the baseline) ⇒ sketch y in [20, 25].
    expect(Math.min(...ys)).toBe(20);
    expect(Math.max(...ys)).toBe(25);
  });

  it('closes an open contour with a line back to its start', () => {
    const prims = outlineToPrimitives(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 10, y: 0 },
        { type: 'L', x: 10, y: -10 },
        { type: 'Z' },
      ],
      PLACE,
    );
    expect(prims).toHaveLength(3);
    expectClosedChains(prims);
  });

  it('elevates a quadratic to the exact cubic', () => {
    const prims = outlineToPrimitives(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'Q', x1: 5, y1: -9, x: 10, y: 0 },
        { type: 'Z' },
      ],
      PLACE,
    );
    expect(prims).toHaveLength(2);
    const b = prims[0]!;
    expect(b.kind).toBe('bezier');
    if (b.kind !== 'bezier') return;
    // q = (5, 9) in sketch space; cp1 = ⅔q, cp2 = p1 + ⅔(q − p1).
    expect(b.cp1[0]).toBeCloseTo(10 / 3, 12);
    expect(b.cp1[1]).toBeCloseTo(6, 12);
    expect(b.cp2[0]).toBeCloseTo(20 / 3, 12);
    expect(b.cp2[1]).toBeCloseTo(6, 12);
    // Midpoint of the cubic equals the quadratic's midpoint (2.5 + 2.5, 4.5).
    const t = 0.5, u = 1 - t;
    const my = u ** 3 * b.start[1] + 3 * u * u * t * b.cp1[1] + 3 * u * t * t * b.cp2[1] + t ** 3 * b.end[1];
    expect(my).toBeCloseTo(4.5, 12);
  });

  it('turns an on-chord quadratic into a line and drops zero-length segments', () => {
    const prims = outlineToPrimitives(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'Q', x1: 5, y1: 0, x: 10, y: 0 },
        { type: 'L', x: 10, y: 0 },
        { type: 'L', x: 10, y: -10 },
        { type: 'L', x: 0, y: 0 },
        { type: 'Z' },
      ],
      PLACE,
    );
    expect(prims.map((p) => p.kind)).toEqual(['line', 'line', 'line']);
    expectClosedChains(prims);
  });

  it('snaps a near-closing end exactly onto the contour start', () => {
    const prims = outlineToPrimitives(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 10, y: 0 },
        { type: 'L', x: 10, y: -10 },
        { type: 'L', x: 1e-6, y: 0 },
        { type: 'Z' },
      ],
      PLACE,
    );
    expect(prims).toHaveLength(3);
    const last = prims[2]!;
    expect(last.kind === 'line' && last.end).toEqual([0, 0]);
  });

  it('keeps a counter as its own loop so the letter region gets a hole', () => {
    const prims = outlineToPrimitives(squareGlyph(10, 0, 3), PLACE);
    expect(prims).toHaveLength(8);
    const regions = regionsOf(prims);
    const ring = regions.find((r) => (r.holes?.length ?? 0) > 0)!;
    expect(ring).toBeDefined();
    expect(regionNetArea(ring)).toBeCloseTo(100 - 16, 6);
  });

  it('drops a contour that collapses to fewer than two segments', () => {
    const prims = outlineToPrimitives(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 0, y: 0 },
        { type: 'Z' },
        ...squareGlyph(10),
      ],
      PLACE,
    );
    expect(prims).toHaveLength(4);
  });
});

/** Fake font: every character is a 600-unit-wide square glyph, cap height 700. */
function squareFont(opts: { os2?: boolean } = {}): OutlineFont {
  return {
    unitsPerEm: 1000,
    ...(opts.os2 === false ? {} : { tables: { os2: { sCapHeight: 700 } } }),
    getPath(text, x, y, fontSize) {
      const k = fontSize / 1000;
      const commands: OutlineCommand[] = [];
      [...text].forEach((ch, i) => {
        if (ch === ' ') return;
        const x0 = x + i * 800 * k;
        commands.push(
          { type: 'M', x: x0, y: y },
          { type: 'L', x: x0 + 600 * k, y: y },
          { type: 'L', x: x0 + 600 * k, y: y - 700 * k },
          { type: 'L', x: x0, y: y - 700 * k },
          { type: 'Z' },
        );
      });
      return { commands };
    },
  };
}

describe('textToPrimitives', () => {
  it('scales so capitals are `height` mm tall, baseline at the origin', () => {
    const prims = textToPrimitives(squareFont(), 'AB', { height: 10, origin: [5, 5] });
    expect(prims).toHaveLength(8);
    const ys = prims.flatMap((p) => (p.kind === 'line' ? [p.start[1]] : []));
    expect(Math.min(...ys)).toBeCloseTo(5, 9);
    expect(Math.max(...ys)).toBeCloseTo(15, 9);
    expect(regionsOf(prims)).toHaveLength(2);
  });

  it('measures the cap height from H when the font has no OS/2 value', () => {
    expect(capHeightUnits(squareFont({ os2: false }))).toBeCloseTo(700, 9);
  });

  it('returns nothing for blank text or a non-positive height', () => {
    expect(textToPrimitives(squareFont(), '   ', { height: 10 })).toEqual([]);
    expect(textToPrimitives(squareFont(), 'A', { height: 0 })).toEqual([]);
  });

  it('lays line breaks out as spaces on one line', () => {
    const prims = textToPrimitives(squareFont(), 'A\nB', { height: 7 });
    const xs = prims.flatMap((p) => (p.kind === 'line' ? [p.start[0]] : []));
    // "A B": the B square starts two advances (2 × 800 units × 0.01) in.
    expect(Math.max(...xs)).toBeCloseTo(16 + 6, 9);
  });
});
