/**
 * Sketch text on the real kernel: glyph outlines built from a font in the
 * document, bounding regions, extruded exactly with one wall per Bézier
 * segment named after it, and picks on a glyph's wall that survive a size
 * change and a string change that keeps the glyph.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  prepareCurve,
  readDocument,
  resolve,
  writeRecord,
  type CurveKey,
  type Loop,
  type NamedEntity,
  type Vec2,
} from '@tweakcad/format';
import { DocBuilder, type SketchHandle } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { Json } from './context';

let k: OcctKernel;
const builds: Evaluation[] = [];
const here = dirname(fileURLToPath(import.meta.url));
// Lilita One, under the SIL Open Font License (its licence text sits next to the file).
const FONT = new Uint8Array(readFileSync(resolvePath(here, '../../../../src/assets/fonts/LilitaOne-Regular.ttf')));

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(doc: Json): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

const DEPTH = 3;

/** A word extruded: every glyph's filled regions, not the counters inside its holes. */
function word(string: string): { d: DocBuilder; sketch: SketchHandle; text: string } {
  const d = new DocBuilder();
  const font = d.font(FONT, 'LilitaOne-Regular.ttf');
  let text = '';
  const sketch = d.sketch('xy', (s) => {
    text = s.text(font, string, 10, [2, 1]);
  });
  const curveOf = (loop: Loop) => {
    const use = loop[0] as Loop[number];
    return JSON.stringify('closed' in use ? use.closed.curve : use.open.curve);
  };
  const holes = new Set(sketch.rows.flatMap((r) => r.holes.set.map(curveOf)));
  const filled = sketch.rows.filter((r) => !holes.has(curveOf(r.loop)));
  d.extrude({
    sketch: sketch.feature,
    profiles: filled.map((r) => sketch.refOf(r.id)),
    sides: [{ distance: `${DEPTH} mm` }],
  });
  return { d, sketch, text };
}

/** The document with the text row's value `field` defined by `text`. */
function edited(d: DocBuilder, field: 'string' | 'size', text: string): Json {
  const doc = d.document();
  const sketch = (((doc.parts as Json[])[0] as Json).timeline as Json[])[0] as Json;
  const row = ((sketch.inputs as Json).text as Json[])[0] as Json;
  ((row[field] as Json).def as Json).expr = { text, grammar: 1, refs: {} };
  return doc;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const entities = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
type Level = { role?: string; src?: ({ id?: { id: string } } & { index?: { i: number } })[] };
const finestOf = (ev: Evaluation, e: NamedEntity) => ev.names.get(e.ladder.at(-1) as string) as Level;
const sides = (ev: Evaluation, d: DocBuilder) =>
  entities(ev, d).filter((e) => e.kind === 'face' && finestOf(ev, e).role === 'side');

/** Where on the glyph contours a wall lies: its segment's distance from the wall's sample point, in the sketch plane. */
function offSegment(ev: Evaluation, d: DocBuilder, sketch: string, face: NamedEntity): number {
  const src = finestOf(ev, face).src!;
  const [text, glyph, contour, segment] = [src[0]!.id!.id, src[1]!.index!.i, src[2]!.index!.i, src[3]!.index!.i];
  const key: CurveKey = { glyph: { text, glyph, contour } };
  const curve = ev.parts
    .get(d.partId)!
    .sketches.get(sketch)!
    .solved.curves.find((c) => JSON.stringify(c.key) === JSON.stringify(key))!;
  if (curve.shape.kind !== 'contour') throw new Error('not a glyph contour');
  const one = prepareCurve({ kind: 'contour', segments: [curve.shape.segments[segment]!] }, false)!;
  const p = ev.adapter.samplePoint(face.key)!;
  return one.closest([p[0], p[1]] as Vec2)[0]!.distance;
}

describe('sketch text', { timeout: 60_000 }, () => {
  it('extrudes a word exactly, one wall per glyph segment named after it', () => {
    const { d, sketch, text } = word('TO');
    const ev = evaluate(d.document());
    expect(ev.pauses).toEqual([]);
    const built = ev.parts.get(d.partId)!.sketches.get(sketch.feature)!;
    // T has one contour, O two; the regions are T, O's ring and O's counter.
    const glyphs = built.solved.curves.filter((c) => 'glyph' in c.key);
    expect(glyphs.map((c) => ('glyph' in c.key ? [c.key.glyph.glyph, c.key.glyph.contour] : []))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(built.detection.regions).toHaveLength(3);

    // The caps are the profiles exactly: the kernel's area is the format's.
    const area = entities(ev, d)
      .filter((e) => e.kind === 'face' && finestOf(ev, e).role === 'start')
      .reduce((s, e) => s + (ev.adapter.measures(e.key).area as number), 0);
    const ring = built.detection.regions.slice().sort((a, b) => b.area - a.area);
    const counter = built.detection.regions.find(
      (r) => r.inner.length === 0 && r !== ring[0] && r.area < ring[1]!.area,
    );
    const filled = built.detection.regions.filter((r) => r !== counter).reduce((s, r) => s + r.area, 0);
    expect(Math.abs(area - filled) / filled).toBeLessThan(1e-7);

    // Every wall lies on the one segment its name gives: text, glyph, contour, segment, then the region.
    const walls = sides(ev, d);
    const segments = glyphs.reduce((s, c) => s + (c.shape.kind === 'contour' ? c.shape.segments.length : 0), 0);
    expect(walls).toHaveLength(segments);
    for (const wall of walls) {
      const src = finestOf(ev, wall).src!;
      expect(src).toHaveLength(5);
      expect(src[0]!.id!.id).toBe(text);
      expect(offSegment(ev, d, sketch.feature, wall)).toBeLessThan(1e-6);
    }
  });

  it('keeps a pick on a wall of the O when the text grows and when a letter is added after it', () => {
    const { d, sketch } = word('TO');
    const evA = evaluate(d.document());
    expect(evA.pauses).toEqual([]);
    // A wall of the O's outer contour, part way round.
    const walls = sides(evA, d).filter((e) => {
      const src = finestOf(evA, e).src!;
      return src[1]!.index!.i === 1 && src[2]!.index!.i === 0;
    });
    const wall = walls[Math.floor(walls.length / 3)]!;
    const record = writeRecord(wall, stateOf(evA, d), evA.adapter);
    const picked = finestOf(evA, wall).src!.map((x) => JSON.stringify(x));

    for (const doc of [edited(d, 'size', '14 mm'), edited(d, 'string', '"TOP"')]) {
      const evB = evaluate(doc);
      expect(evB.pauses).toEqual([]);
      const found = resolve(record, stateOf(evB, d), evB.adapter);
      expect(found.outcome).toBe('same');
      if (found.outcome !== 'same') continue;
      expect(found.entities).toHaveLength(1);
      const face = found.entities[0]!;
      expect(finestOf(evB, face).src!.map((x) => JSON.stringify(x))).toEqual(picked);
      expect(offSegment(evB, d, sketch.feature, face)).toBeLessThan(1e-6);
    }
  });

  it('extrudes glyphs a drawn line cuts across, the walls on the cut segments trimmed exactly', () => {
    const d = new DocBuilder();
    const font = d.font(FONT, 'LilitaOne-Regular.ttf');
    let line = '';
    const sketch = d.sketch('xy', (s) => {
      s.text(font, 'O', 10, [0, 0]);
      line = s.line(s.point(-5, 4.3), s.point(20, 4.3));
    });
    d.extrude({
      sketch: sketch.feature,
      profiles: sketch.rows.map((r) => sketch.refOf(r.id)),
      sides: [{ distance: `${DEPTH} mm` }],
    });
    const ev = evaluate(d.document());
    expect(ev.pauses).toEqual([]);
    const built = ev.parts.get(d.partId)!.sketches.get(sketch.feature)!;
    // The ring and the counter, each in two.
    expect(built.detection.regions).toHaveLength(4);
    const area = entities(ev, d)
      .filter((e) => e.kind === 'face' && finestOf(ev, e).role === 'start')
      .reduce((s, e) => s + (ev.adapter.measures(e.key).area as number), 0);
    const regions = built.detection.regions.reduce((s, r) => s + r.area, 0);
    expect(Math.abs(area - regions) / regions).toBeLessThan(1e-7);
    const walls = sides(ev, d);
    const glyphWalls = walls.filter((w) => finestOf(ev, w).src!.length === 5);
    for (const wall of glyphWalls) expect(offSegment(ev, d, sketch.feature, wall)).toBeLessThan(1e-6);
    // The pieces on either side of the line fuse, so no wall stands on it.
    expect(walls.filter((w) => finestOf(ev, w).src![0]!.id!.id === line)).toHaveLength(0);
    expect(glyphWalls.length).toBeGreaterThan(0);
  });

  it('pauses text along a curve, and text whose font is missing', () => {
    const along = word('TO');
    const doc = along.d.document();
    const sketch = (((doc.parts as Json[])[0] as Json).timeline as Json[])[0] as Json;
    const row = ((sketch.inputs as Json).text as Json[])[0] as Json;
    const line = ((sketch.inputs as Json).curves as Json[])[0];
    expect(line).toBeUndefined();
    // A path along a curve of the sketch.
    const inputs = sketch.inputs as Json;
    const [a, b] = [along.d.id('pt'), along.d.id('pt')];
    (inputs.points as Json[]).push({ id: a, x: 0, y: -2 }, { id: b, x: 30, y: -2 });
    const curve = along.d.id('crv');
    (inputs.curves as Json[]).push({
      id: curve,
      kind: 'line',
      construction: along.d.val('true'),
      origin: { drawn: {} },
      start: a,
      end: b,
    });
    row.path = { along: { curves: [curve] } };
    const ev = evaluate(doc);
    expect(ev.pauses[0]?.feature).toBe(along.sketch.feature);
    expect(ev.pauses[0]?.message).toMatch(/along a curve is not built/);

    const missing = word('TO').d.document();
    const entry = (missing.library as Json[])[0] as Json;
    entry.content = { missing: { name: 'LilitaOne-Regular.ttf' } };
    delete entry.hash;
    const evMissing = evaluate(missing);
    expect(evMissing.pauses[0]?.message).toMatch(/font is missing/);
  });
});
