import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { contentHash, nameHash } from '../hash';
import { readDocument, type ReadResult } from './document';
import type { Json } from './reader';

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string, refs: Json = {}): Json => ({
  id: id('val', nextValue++),
  def: { expr: { text, grammar: 1, refs } },
});

const PART = id('part', 1);
const FEAT = id('feat', 1);
const pt = (n: number) => id('pt', n);
const crv = (n: number) => id('crv', n);

function rectangle(): Json {
  const points = [
    [0, 0],
    [10, 0],
    [10, 5],
    [0, 5],
  ].map(([x, y], i) => ({ id: pt(i + 1), x, y }));
  const curves = [0, 1, 2, 3].map((i) => ({
    id: crv(i + 1),
    kind: 'line',
    construction: val('false'),
    origin: { drawn: {} },
    start: pt(i + 1),
    end: pt(((i + 1) % 4) + 1),
  }));
  const use = (i: number) => ({
    open: {
      curve: { drawn: { id: crv(i + 1) } },
      from: { point: { id: pt(i + 1) } },
      to: { point: { id: pt(((i + 1) % 4) + 1) } },
      reversed: false,
    },
  });
  return {
    frame: {
      attach: {
        support: [{ standard: { name: 'xy' } }],
        mode: val('"plane"'),
        offset: val('placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))'),
        flip: val('false'),
      },
    },
    points,
    curves,
    constraints: [
      { id: id('con', 1), kind: 'horizontal', active: val('true'), of: { curve: { id: crv(1) } } },
      {
        id: id('con', 2),
        kind: 'distance',
        active: val('true'),
        a: { point: { id: pt(1) } },
        b: { point: { id: pt(2) } },
        value: val('10 mm'),
        solved: 10,
        label: { auto: {} },
      },
    ],
    regions: [{ id: id('reg', 1), loop: [0, 1, 2, 3].map(use), holes: { set: [] }, origin: { detected: {} } }],
    retired: [],
    text: [],
  };
}

function docWith(inputs: Json): Json {
  return {
    format: 'tweakcad.document',
    schemaVersion: 2,
    namingRules: 1,
    id: id('doc', 1),
    metadata: {
      name: 'Sketch',
      description: '',
      createdAt: '2026-11-05T00:00:00Z',
      updatedAt: '2026-11-05T00:00:00Z',
      writer: { app: 'test', version: '0' },
      origin: { original: {} },
    },
    properties: {},
    settings: {},
    parameters: [],
    parts: [
      {
        id: PART,
        name: 'Part',
        parameters: [],
        timeline: [
          {
            id: FEAT,
            type: 'core.sketch',
            typeVersion: 1,
            name: 'Sketch',
            suppressed: val('false'),
            frozen: { live: {} },
            command: { alone: {} },
            inputs,
          },
        ],
        rollback: { end: {} },
        groups: [],
        sets: [],
        contexts: [],
        attributes: [],
        configurations: [],
        notes: [],
        properties: {},
      },
    ],
    assemblies: [],
    root: { part: { id: PART } },
    folders: [],
    views: [],
    library: [],
    assets: {},
    names: {},
  };
}

const read = (inputs: Json, top: Json = {}): ReadResult =>
  readDocument(JSON.parse(JSON.stringify({ ...docWith(inputs), ...top })));
const codes = (result: ReadResult, severity: string) =>
  result.diagnostics
    .filter((d) => d.severity === severity)
    .map((d) => `${d.code} ${d.path.replace('/parts/0/timeline/0/inputs', '')}`);

describe('core.sketch', () => {
  it('reads a constrained, dimensioned rectangle with its region', () => {
    expect(read(rectangle()).diagnostics).toEqual([]);
  });

  it('reads every attachment mode of the registry; a mode it does not know is no refusal (it pauses)', () => {
    const withMode = (mode: string): Json => {
      const s = rectangle();
      ((s.frame as Json).attach as Json).mode = val(`"${mode}"`);
      return s;
    };
    for (const mode of ['plane', 'planeAtPoint', 'threePoints', 'twoPoints', 'point', 'alongLine'])
      expect(codes(read(withMode(mode)), 'refuse')).toEqual([]);
    expect(codes(read(withMode('sideways')), 'refuse')).toEqual([]);
  });

  it('refuses a curve naming a point the sketch does not have', () => {
    const s = rectangle();
    (s.curves as Json[])[0]!.end = pt(9);
    expect(codes(read(s), 'refuse')).toEqual(['dangling /curves/0/end']);
  });

  it('pauses on unknown curve and constraint kinds', () => {
    const s = rectangle();
    (s.curves as Json[]).push({ id: crv(9), kind: 'clothoid', construction: val('false'), origin: { drawn: {} } });
    (s.constraints as Json[]).push({ id: id('con', 9), kind: 'gearMesh', active: val('true') });
    expect(codes(read(s), 'pause')).toEqual(['unknown-variant /curves/4/kind', 'unknown-variant /constraints/2/kind']);
  });

  it('refuses a dimension whose value has the wrong quantity', () => {
    const s = rectangle();
    (s.constraints as Json[])[1]!.value = val('10 deg');
    expect(codes(read(s), 'refuse')).toEqual(['bad-expression /constraints/1/value/def/expr']);
  });

  it('refuses curve ancestry cycles and bad crossing ends', () => {
    const s = rectangle();
    const curves = s.curves as Json[];
    curves[0]!.origin = { from: { id: crv(2) } };
    curves[1]!.origin = { from: { id: crv(1) } };
    expect(codes(read(s), 'refuse')).toEqual(['cycle /curves']);

    const t = rectangle();
    const loop = ((t.regions as Json[])[0]!.loop as Json[])[0] as { open: Json };
    loop.open.to = { cross: { with: { drawn: { id: crv(2) } }, sense: 2, k: 0, kWith: 0 } };
    expect(codes(read(t), 'refuse')).toEqual(['bad-value /regions/0/loop/0/open/to/cross/sense']);
  });

  it('requires index, count and near together on an external curve', () => {
    const s = rectangle();
    (s.curves as Json[]).push({
      id: crv(9),
      kind: 'external',
      construction: val('true'),
      origin: { drawn: {} },
      source: { standard: { name: 'x' } },
      defining: val('false'),
      mode: val('"intersect"'),
      index: 0,
    });
    expect(codes(read(s), 'refuse')).toEqual(['missing-field /curves/4']);
  });

  it('follows retired regions merged into live ones, and refuses merge cycles', () => {
    const s = rectangle();
    const region = (s.regions as Json[])[0]!;
    const fields = { loop: region.loop, holes: region.holes, origin: { detected: {} } };
    s.retired = [{ id: id('reg', 2), was: { region: fields }, fate: { merged: { into: { id: id('reg', 1) } } } }];
    expect(read(s).diagnostics).toEqual([]);
    s.retired = [
      { id: id('reg', 2), was: { region: fields }, fate: { merged: { into: { id: id('reg', 3) } } } },
      { id: id('reg', 3), was: { region: fields }, fate: { merged: { into: { id: id('reg', 2) } } } },
    ];
    expect(codes(read(s), 'refuse')).toEqual(['cycle /retired']);
  });

  it('keeps a deleted text row in retired, and refuses one with another fate', () => {
    const bytes = new TextEncoder().encode('font');
    const asset = contentHash(bytes);
    const content = { inline: { definition: { asset } } };
    const lib = id('lib', 1);
    const top = {
      library: [{ id: lib, hash: nameHash(content), kind: 'font', content, source: { local: {} }, name: 'Font' }],
      assets: {
        [asset]: {
          mediaType: 'font/ttf',
          name: 'font.ttf',
          size: bytes.length,
          data: { inline: { base64: btoa('font') } },
        },
      },
    };
    const text = () => ({
      string: val('"A"'),
      font: val('f', { f: { library: { id: lib } } }),
      size: val('5 mm'),
      frame: { fixed: { placement: val('placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))') } },
      path: { straight: {} },
    });
    const s = rectangle();
    s.retired = [{ id: id('txt', 1), was: { text: text() }, fate: { deleted: {} } }];
    expect(read(s, top).diagnostics).toEqual([]);
    s.retired = [{ id: id('txt', 1), was: { text: text() }, fate: { split: {} } }];
    expect(codes(read(s, top), 'refuse')).toEqual(['bad-value /retired/0/fate/split']);
  });

  it('takes the sketch origin where a point goes and its axes where a line goes', () => {
    const s = rectangle();
    const std = (name: string) => ({ sketchStandard: { name } });
    const con = (n: number, kind: string, fields: Json, dimension = false): Json => ({
      id: id('con', n),
      kind,
      active: val('true'),
      ...fields,
      ...(dimension ? { value: val(kind === 'angle' ? '30 deg' : '5 mm'), solved: 0, label: { auto: {} } } : {}),
    });
    const P = (n: number) => ({ point: { id: pt(n) } });
    const C = (n: number) => ({ curve: { id: crv(n) } });
    const constraints = s.constraints as Json[];
    constraints.push(
      con(10, 'horizontal', { of: { points: { a: std('origin'), b: P(1) } } }),
      con(11, 'pointOnCurve', { point: P(2), curve: std('x') }),
      con(12, 'parallel', { a: C(1), b: std('y') }),
      con(13, 'distance', { a: P(3), b: std('y') }, true),
      con(14, 'distanceX', { a: std('origin'), b: P(4) }, true),
      con(15, 'angle', { a: std('x'), b: C(2) }, true),
      con(16, 'symmetric', { a: P(1), b: P(2), axis: std('y') }),
      con(17, 'midpoint', { point: std('origin'), curve: C(1) }),
    );
    expect(read(s).diagnostics).toEqual([]);

    const t = rectangle();
    (t.constraints as Json[]).push(
      con(20, 'pointOnCurve', { point: std('x'), curve: C(1) }),
      con(21, 'equal', { a: C(1), b: std('x') }),
      con(22, 'fixed', { point: std('origin') }),
      con(23, 'radius', { curve: std('y') }, true),
      con(24, 'distance', { a: std('origin'), b: std('x') }, true),
      con(25, 'midpoint', { point: P(1), curve: std('x') }),
    );
    expect(codes(read(t), 'refuse')).toEqual([
      'bad-value /constraints/2/point/sketchStandard',
      'bad-value /constraints/3/b/sketchStandard',
      'bad-value /constraints/4/point/sketchStandard',
      'bad-value /constraints/5/curve/sketchStandard',
      'bad-value /constraints/6',
      'bad-value /constraints/7/curve/sketchStandard',
    ]);

    const u = rectangle();
    (u.constraints as Json[]).push(con(30, 'pointOnCurve', { point: P(1), curve: std('z') }));
    expect(codes(read(u), 'pause')).toEqual(['unknown-variant /constraints/2/curve/sketchStandard/name']);
  });

  it('pauses an unknown solver version', () => {
    expect(codes(read({ ...rectangle(), solver: 2 }), 'pause')).toEqual(['unknown-version /solver']);
  });
});
