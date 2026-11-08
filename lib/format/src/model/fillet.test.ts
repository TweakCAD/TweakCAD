import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { readDocument, type ReadResult } from './document';
import type { Json } from './reader';

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string): Json => ({ id: id('val', nextValue++), def: { expr: { text, grammar: 1, refs: {} } } });

const PART = id('part', 1);
const targets = { set: [{ object: { feature: { id: id('feat', 1) } } }] };

function read(type: string, inputs: Json): ReadResult {
  const feature = {
    id: id('feat', 1),
    type,
    typeVersion: 1,
    name: 'Blend',
    suppressed: val('false'),
    frozen: { live: {} },
    command: { alone: {} },
    inputs,
  };
  const part = {
    id: PART,
    name: 'Part',
    parameters: [],
    timeline: [feature],
    rollback: { end: {} },
    groups: [],
    sets: [],
    contexts: [],
    attributes: [],
    configurations: [],
    notes: [],
    properties: {},
  };
  return readDocument(
    JSON.parse(
      JSON.stringify({
        format: 'tweakcad.document',
        schemaVersion: 2,
        namingRules: 1,
        id: id('doc', 1),
        metadata: {
          name: 'Blend',
          description: '',
          createdAt: '2026-11-05T00:00:00Z',
          updatedAt: '2026-11-05T00:00:00Z',
          writer: { app: 'test', version: '0' },
          origin: { original: {} },
        },
        properties: {},
        settings: {},
        parameters: [],
        parts: [part],
        assemblies: [],
        root: { part: { id: PART } },
        folders: [],
        views: [],
        library: [],
        assets: {},
        names: {},
      }),
    ),
  );
}

const refused = (result: ReadResult) =>
  result.diagnostics
    .filter((d) => d.severity === 'refuse')
    .map((d) => `${d.code} ${d.path.replace('/parts/0/timeline/0/inputs', '')}`);

describe('core.fillet', () => {
  it('reads each radius form', () => {
    const radii = [
      { constant: { s: val('1 mm') } },
      { chord: { s: val('1 mm') } },
      {
        variable: {
          points: [
            { at: val('0'), radius: val('1 mm') },
            { at: val('1'), radius: val('2 mm') },
          ],
        },
      },
    ];
    expect(
      read('core.fillet', { sets: radii.map((radius) => ({ targets, radius, setback: val('0 mm') })) }).diagnostics,
    ).toEqual([]);
  });

  it('refuses no sets, an empty target set and a radius that is not a length', () => {
    expect(refused(read('core.fillet', { sets: [] }))).toEqual(['bad-value /sets']);
    const radius = { constant: { s: val('1 mm') } };
    expect(refused(read('core.fillet', { sets: [{ targets: { set: [] }, radius, setback: val('0 mm') }] }))).toEqual([
      'bad-value /sets/0/targets',
    ]);
    expect(
      refused(
        read('core.fillet', { sets: [{ targets, radius: { constant: { s: val('1 deg') } }, setback: val('0 mm') }] }),
      ),
    ).toEqual(['bad-expression /sets/0/radius/constant/s/def/expr']);
  });

  it('requires a setback', () => {
    expect(refused(read('core.fillet', { sets: [{ targets, radius: { constant: { s: val('1 mm') } } }] }))).toContain(
      'missing-field /sets/0/setback',
    );
  });
});

describe('core.chamfer', () => {
  it('reads each size form', () => {
    const sizes = [
      { distance: { d: val('1 mm') } },
      { twoDistances: { d1: val('1 mm'), d2: val('2 mm') } },
      { distanceAngle: { d: val('1 mm'), angle: val('30 deg') } },
    ];
    expect(read('core.chamfer', { sets: sizes.map((size) => ({ targets, size })) }).diagnostics).toEqual([]);
  });

  it('refuses no sets and an angle that is not an angle', () => {
    expect(refused(read('core.chamfer', { sets: [] }))).toEqual(['bad-value /sets']);
    expect(
      refused(
        read('core.chamfer', { sets: [{ targets, size: { distanceAngle: { d: val('1 mm'), angle: val('30 mm') } } }] }),
      ),
    ).toEqual(['bad-expression /sets/0/size/distanceAngle/angle/def/expr']);
  });

  it('reads a flipped distance-and-angle size, and refuses a flip that is not a flag', () => {
    const size = (flipped: string) => ({
      distanceAngle: { d: val('1 mm'), angle: val('30 deg'), flipped: val(flipped) },
    });
    expect(read('core.chamfer', { sets: [{ targets, size: size('true') }] }).diagnostics).toEqual([]);
    expect(refused(read('core.chamfer', { sets: [{ targets, size: size('2 mm') }] }))).toEqual([
      'bad-expression /sets/0/size/distanceAngle/flipped/def/expr',
    ]);
  });
});

describe('core.shell', () => {
  const shell = (extra: Json) => ({
    bodies: { set: targets.set },
    remove: { set: [] },
    thickness: val('2 mm'),
    direction: val('"both"'),
    ...extra,
  });

  it('reads a body shelled with no removed face, and an outside thickness', () => {
    expect(read('core.shell', shell({})).diagnostics).toEqual([]);
    expect(read('core.shell', shell({ outsideThickness: val('1 mm') })).diagnostics).toEqual([]);
  });

  it('refuses an outside thickness that is not a length', () => {
    expect(refused(read('core.shell', shell({ outsideThickness: val('1 deg') })))).toEqual([
      'bad-expression /outsideThickness/def/expr',
    ]);
  });
});
