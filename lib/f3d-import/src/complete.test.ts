import { describe, expect, it } from 'vitest';
import { complete, type F3dClient } from './complete';
import type { RoundStep } from './convert';
import type { Json } from './writer';

const doc = (): Json => ({
  parts: [
    {
      id: 'p',
      timeline: [
        { id: 'a', type: 'core.extrude', inputs: {} },
        { id: 'b', type: 'core.extrude', inputs: {} },
      ],
    },
  ],
  names: {},
  assets: { big: {} },
});
const step = (before: string | undefined, id = 'f'): RoundStep => ({
  kind: 'round',
  part: 'p',
  before,
  object: `Fillet ${id}`,
  id,
  sets: [
    {
      pairs: [
        [
          { kind: 'sphere', center: [0, 0, 0], radius: 1 },
          { kind: 'sphere', center: [1, 0, 0], radius: 1 },
        ],
      ],
      row: (refs) => ({ refs }),
    },
  ],
  row: (sets) => ({ id, sets }),
});
const client = (over: Partial<F3dClient> = {}): F3dClient => ({
  evaluate: () => Promise.resolve(),
  vetSketch: () => Promise.resolve([]),
  vetSketches: (_doc, features) => Promise.resolve(features.map(() => [])),
  locateOnSurfaces: () => Promise.resolve([[{ reference: { entity: {} }, names: {} }]]),
  bodiesMadeBy: () => Promise.resolve([]),
  locateFacesOnSurfaces: () => Promise.resolve([]),
  importFile: () => Promise.reject(new Error('no stored bodies here')),
  ...over,
});
const ids = (d: Json) => (((d.parts as Json[])[0] as Json).timeline as Json[]).map((f) => f.id);

describe('complete', () => {
  it('writes a step before the feature that came after it', async () => {
    const d = doc();
    await complete(d, [step('b')], client());
    expect(ids(d)).toEqual(['a', 'f', 'b']);
  });

  it('builds only what comes before a step, with the assets a stored shape needs, meshing nothing', async () => {
    const seen: [Json, unknown][] = [];
    await complete(
      doc(),
      [step('b')],
      client({ evaluate: (x, options) => Promise.resolve(void seen.push([x as Json, options])) }),
    );
    // No sketch needs a build to be vetted: the step's is the only one.
    expect(seen).toHaveLength(1);
    expect(ids(seen[0]![0])).toEqual(['a']);
    expect(seen[0]![0].assets).toEqual({ big: {} });
    expect(seen[0]![1]).toEqual({ meshes: false });
  });

  it('builds nothing for a file with no steps whose sketches its values vet', async () => {
    const d: Json = {
      parts: [
        {
          id: 'p',
          timeline: [{ id: 's', type: 'core.sketch', inputs: { constraints: [{ id: 'c1' }, { id: 'c2' }] } }],
        },
      ],
      names: {},
      assets: {},
    };
    const evaluated: unknown[] = [];
    await complete(
      d,
      [],
      client({
        evaluate: (x) => Promise.resolve(void evaluated.push(x)),
        vetSketches: () => Promise.resolve([['c2']]),
      }),
    );
    expect(evaluated).toEqual([]);
    expect(((((d.parts as Json[])[0] as Json).timeline as Json[])[0] as Json).inputs).toEqual({
      constraints: [{ id: 'c1' }],
    });
  });

  it('writes an edge two pairs name once', async () => {
    const d = doc();
    await complete(
      d,
      [step(undefined)],
      client({
        locateOnSurfaces: () =>
          Promise.resolve([
            [{ reference: { entity: { e: 1 } }, names: {} }],
            [{ reference: { entity: { e: 1 } }, names: {} }],
          ]),
      }),
    );
    const row = (((d.parts as Json[])[0] as Json).timeline as Json[])[2] as Json;
    expect(((row.sets as Json[])[0] as Json).refs).toHaveLength(1);
  });

  it('counts the edges not found', async () => {
    const notes = await complete(
      doc(),
      [step(undefined)],
      client({ locateOnSurfaces: () => Promise.resolve([[{ reference: { entity: {} }, names: {} }], []]) }),
    );
    expect(notes.map((n) => n.message)).toEqual([
      '1 of its 2 edges were not found in the imported model and were left out',
    ]);
  });

  it('leaves out a step the worker cannot finish, and goes on', async () => {
    const d = doc();
    let n = 0;
    const flaky = client({ evaluate: () => (++n === 1 ? Promise.reject(new Error('no')) : Promise.resolve()) });
    const notes = await complete(d, [step(undefined, 'x'), step(undefined, 'y')], flaky);
    expect(notes).toEqual([
      { severity: 'warning', object: 'Fillet x', message: 'it could not be finished, so it was left out: no' },
    ]);
    expect(ids(d)).toEqual(['a', 'b', 'y']);
  });

  it('reports each sketch it checks and each step it finishes', async () => {
    const d = doc();
    (((d.parts as Json[])[0] as Json).timeline as Json[]).unshift({
      id: 's',
      type: 'core.sketch',
      inputs: { constraints: [{ id: 'c1' }] },
    });
    const heard: [string, number, number][] = [];
    await complete(d, [step(undefined, 'x'), step(undefined, 'y')], client(), (label, done, total) =>
      heard.push([label, done, total]),
    );
    expect(heard).toEqual([
      ['Checking sketches', 0, 0],
      ['Finishing Fillet x', 0, 2],
      ['Finishing Fillet y', 1, 2],
    ]);
  });

  it('takes out the constraints the solver cannot hold, building the parts first for a sketch whose values need them', async () => {
    const d: Json = {
      parts: [
        {
          id: 'p',
          timeline: [{ id: 's', type: 'core.sketch', inputs: { constraints: [{ id: 'c1' }, { id: 'c2' }] } }],
        },
      ],
      names: {},
      assets: {},
    };
    const calls: string[] = [];
    const notes = await complete(
      d,
      [],
      client({
        vetSketches: () => Promise.resolve([null]),
        evaluate: (_, options) => Promise.resolve(void calls.push(`evaluate ${JSON.stringify(options)}`)),
        vetSketch: () => (calls.push('vet'), Promise.resolve(['c2'])),
      }),
    );
    expect(calls).toEqual(['evaluate {"meshes":false}', 'vet']);
    const sketch = (((d.parts as Json[])[0] as Json).timeline as Json[])[0] as Json;
    expect((sketch.inputs as Json).constraints).toEqual([{ id: 'c1' }]);
    expect(notes[0]?.message).toContain('1 sketch constraint the solver could not hold was left out');
  });
});
