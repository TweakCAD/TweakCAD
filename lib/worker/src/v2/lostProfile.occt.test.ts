/**
 * A profile whose sketch region is gone (its curves deleted) pauses the
 * feature with a plain message naming what is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

type Row = Record<string, unknown>;

describe('a lost profile', () => {
  it('pauses its extrude saying the region it used is gone', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 20, 10);
      x.circle(40, 5, 3);
    });
    const extrude = d.extrude({ sketch: s.feature, profiles: [s.region([40, 5])], sides: [{ distance: '5 mm' }] });
    const doc = d.document() as Row;
    // The circle is deleted from the sketch: the region the extrude used is gone.
    const sketch = ((doc.parts as Row[])[0]?.timeline as Row[]).find((f) => f.id === s.feature) as Row;
    const inputs = sketch.inputs as Row;
    inputs.curves = (inputs.curves as Row[]).filter((c) => !('circle' in c) && c.kind !== 'circle');
    const ev = evaluateDocument(doc, k);
    builds.push(ev);
    const pause = ev.pauses.find((p) => p.feature === extrude);
    expect(pause?.message).toBe('a profile is missing: the sketch region it used is gone');
  });
});
