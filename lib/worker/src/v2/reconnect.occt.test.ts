/**
 * A reference to reconnect (an entity record with an empty `id`, 9.2) pauses
 * the feature that holds it, as a gone reference does: a profile, a sketch's
 * plane support and an edge to blend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';

type Json = Record<string, unknown>;
let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

const reconnect = (): Json => ({ entity: { id: [], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } });

function evaluate(doc: Json): Evaluation {
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

describe('a reference to reconnect', { timeout: 60_000 }, () => {
  it('pauses an extrude whose profile is to be reconnected', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
    const extrude = d.extrude({ sketch: s.feature, profiles: [reconnect()] });
    const ev = evaluate(d.document());
    expect(ev.pauses.map((p) => [p.feature, p.message])).toEqual([[extrude, 'a profile is to be reconnected']]);
  });

  it('pauses a sketch whose plane support is to be reconnected', () => {
    const d = new DocBuilder();
    const base = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
    d.extrude({ sketch: base.feature, profiles: [base.region([1, 1])] });
    const s = d.sketch('xy', (x) => x.circle(5, 5, 2));
    const doc = d.document();
    const timeline = ((doc.parts as Json[])[0] as Json).timeline as Json[];
    const frame = ((timeline[2] as Json).inputs as Json).frame as Json;
    ((frame.attach as Json).support as Json[])[0] = reconnect();
    const ev = evaluate(doc);
    expect(ev.pauses.map((p) => p.feature)).toEqual([s.feature]);
  });

  it('pauses a sketch on a construction plane that did not build, saying so', () => {
    const d = new DocBuilder();
    const plane = d.feature('core.constructionPlane', {
      frame: {
        attach: {
          support: [reconnect()],
          mode: d.val('"plane"'),
          offset: d.val('placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))'),
          flip: d.val('false'),
        },
      },
    });
    const s = d.sketch('xy', (x) => x.circle(5, 5, 2));
    const doc = d.document();
    const timeline = ((doc.parts as Json[])[0] as Json).timeline as Json[];
    const frame = ((timeline[1] as Json).inputs as Json).frame as Json;
    ((frame.attach as Json).support as Json[])[0] = { object: { feature: { id: plane } } };
    const ev = evaluate(doc);
    expect(ev.pauses.map((p) => [p.feature, p.message])).toContainEqual([s.feature, 'the plane support did not build']);
  });

  it('pauses a fillet whose edge is to be reconnected', () => {
    const d = new DocBuilder();
    const base = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
    d.extrude({ sketch: base.feature, profiles: [base.region([1, 1])] });
    const fillet = d.feature('core.fillet', {
      sets: [{ targets: { set: [reconnect()] }, radius: { constant: { s: d.val('1 mm') } }, setback: d.val('0 mm') }],
    });
    const ev = evaluate(d.document());
    expect(ev.pauses.map((p) => p.feature)).toEqual([fillet]);
  });
});
