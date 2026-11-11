import { describe, expect, it } from 'vitest';
import { complete, type LocateClient } from './complete';
import type { Check, LocateStep } from './convert';
import type { Json } from './writer';

const measures = { volume: 10, center: [0, 0, 0], min: [0, 0, 0], max: [1, 1, 1] };
const brep = new Uint8Array([1]);
const feature = (id: string, type: string, inputs: Json): Json => ({
  id,
  type,
  inputs,
  suppressed: { def: { expr: { text: 'false' } } },
});
const doc = (parts: Record<string, string[]>): Json => ({
  assets: {},
  names: {},
  parts: Object.entries(parts).map(([id, features]) => ({
    id,
    timeline: features.map((f) => feature(f, 'core.extrude', {})),
  })),
});
const check = (part: string, id: string): Check => ({
  part,
  feature: id,
  object: id,
  brep,
  name: `${id}.brp`,
  row: (stored) => feature(id, 'core.import', { stored }),
});

/** A client whose document builds as FreeCAD stored it, apart from what `pausing` says. */
function clientOf(pausing: (d: Json) => string[] = () => []) {
  const evaluations: unknown[] = [];
  const located: (string | undefined)[] = [];
  const client: LocateClient = {
    evaluate: (d, options) => {
      evaluations.push(options);
      return Promise.resolve({ pauses: pausing(d as Json).map((feature) => ({ feature })) });
    },
    locate: (_, before) => {
      located.push(before);
      return Promise.resolve([{ reference: { entity: 'found' }, names: {} }]);
    },
    bodyRecords: () => Promise.resolve([]),
    importFile: () => Promise.resolve({ assets: {}, stored: { kept: true } }),
    shapeMeasures: () => Promise.resolve(measures),
    stepMeasures: () => Promise.resolve(measures),
  };
  return { client, evaluations, located };
}

describe('checking a document against the shapes FreeCAD stored', () => {
  it('evaluates once for all its parts, with no meshes, while nothing changes', async () => {
    const parts = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`part${i}`, [`feat${i}`]]));
    const { client, evaluations } = clientOf();
    const notes = await complete(
      doc(parts),
      [],
      client,
      Object.entries(parts).map(([part, [f]]) => check(part, f as string)),
    );
    expect(notes).toEqual([]);
    expect(evaluations).toEqual([{ meshes: false }]);
  });

  it('finds again what a feature references once a stored shape stands before it', async () => {
    const written = doc({ part: ['first'] });
    const rows = (written.parts as Json[])[0]?.timeline as Json[];
    const step: LocateStep = {
      kind: 'locate',
      part: 'part',
      before: undefined,
      object: 'second',
      id: 'second',
      shape: 'brep',
      entity: 'edge',
      indices: [0],
      row: (refs) => feature('second', 'core.fillet', { refs }),
    };
    // The first feature does not build; the second has lost its target until it is found again.
    const { client, located } = clientOf(() =>
      rows[0]?.type === 'core.extrude' ? ['first'] : located.length < 2 ? ['second'] : [],
    );
    const notes = await complete(written, [step], client, [check('part', 'first'), check('part', 'second')]);
    expect(located).toEqual([undefined, 'second']);
    expect(notes.map((n) => n.object)).toEqual(['first']);
    expect(rows.map((f) => f.type)).toEqual(['core.import', 'core.fillet']);
  });

  it('never changes a document it has had evaluated, as it rewrites its own between steps', async () => {
    const written = doc({ part: ['first', 'second'] });
    const sent: { doc: Json; text: string }[] = [];
    const { client } = clientOf(() => (sent.length < 2 ? ['first'] : []));
    const evaluate = client.evaluate;
    client.evaluate = (d, options) => {
      sent.push({ doc: d as Json, text: JSON.stringify(d) });
      return evaluate(d, options);
    };
    await complete(written, [], client, [check('part', 'first'), check('part', 'second')]);
    expect(sent.length).toBeGreaterThan(1);
    for (const { doc: d, text } of sent) expect(JSON.stringify(d)).toBe(text);
  });
});
