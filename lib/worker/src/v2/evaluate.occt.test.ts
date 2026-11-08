/**
 * A version-2 document built end to end on the real kernel: a sketch region
 * extruded into a body whose faces are named, with picks that survive
 * everyday edits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  NameTable,
  base32Encode,
  detectRegions,
  idItem,
  ladderOf,
  readDocument,
  resolve,
  writeRecord,
  type NamedEntity,
  type ShapeKey,
  type SolvedSketch,
  type Vec3,
} from '@tweakcad/format';
import { evaluateDocument, type Evaluation } from './evaluate';
import { DocBuilder } from './docBuilder';
import { box, fixedFrame } from './primitivesDocs';

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

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
const PART = id('part', 1);
const SK = id('feat', 1);
const EX = id('feat', 2);
const REG = id('reg', 1);

let nextValue = 1;
const val = (text: string, n?: number): Json => ({
  id: n === undefined ? id('val', nextValue++) : id('val', n),
  def: { expr: { text, grammar: 1, refs: {} } },
});

/** A 20 × 10 plate with a 2 mm hole, `width` wide, extruded `depth`. */
function plate(width: number, depth: string): Json {
  nextValue = 1;
  const corners = [
    [0, 0],
    [width, 0],
    [width, 10],
    [0, 10],
  ];
  const points = [...corners.map(([x, y], i) => ({ id: id('pt', i + 1), x, y })), { id: id('pt', 9), x: 5, y: 5 }];
  const lines = [0, 1, 2, 3].map((i) => ({
    id: id('crv', i + 1),
    kind: 'line',
    construction: val('false'),
    origin: { drawn: {} },
    start: id('pt', i + 1),
    end: id('pt', ((i + 1) % 4) + 1),
  }));
  const circle = {
    id: id('crv', 9),
    kind: 'circle',
    construction: val('false'),
    origin: { drawn: {} },
    center: id('pt', 9),
    radius: 2,
  };

  // The stored region: the plate around the hole, as the editor would have written it.
  const solved: SolvedSketch = {
    points: points.map((p) => ({ id: p.id, x: p.x as number, y: p.y as number })),
    curves: [
      ...lines.map((l) => ({
        key: { drawn: { id: l.id } },
        shape: { kind: 'line' as const, start: at(points, l.start), end: at(points, l.end) },
        anchors: { kind: 'points' as const, start: l.start, end: l.end },
      })),
      {
        key: { drawn: { id: circle.id } },
        shape: { kind: 'circle' as const, center: [5, 5] as const, radius: 2 },
        anchors: { kind: 'none' as const },
      },
    ],
  };
  const ring = detectRegions(solved).regions.find((r) => r.holes.set.length === 1);
  if (!ring) throw new Error('no ring region');

  const names = new NameTable();
  const ladder = ladderOf({ kind: 'region', chain: [], feature: SK, role: 'region', src: [idItem(REG)] }, names);
  const profile = { entity: { id: ladder, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };

  const feature = (fid: string, type: string, inputs: Json): Json => ({
    id: fid,
    type,
    typeVersion: 1,
    name: type,
    suppressed: val('false'),
    frozen: { live: {} },
    command: { alone: {} },
    inputs,
  });
  const sketch = feature(SK, 'core.sketch', {
    frame: {
      attach: {
        support: [{ standard: { name: 'xy' } }],
        mode: val('"plane"'),
        offset: val('placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))'),
        flip: val('false'),
      },
    },
    points,
    curves: [...lines, circle],
    constraints: [],
    regions: [{ id: REG, loop: ring.loop, holes: ring.holes, origin: { detected: {} } }],
    retired: [],
    text: [],
  });
  const extrude = feature(EX, 'core.extrude', {
    profiles: { set: [profile] },
    sides: [{ extent: { distance: { d: val(depth, 200) } }, taper: val('0 deg') }],
    direction: { normal: { ref: { object: { feature: { id: SK } } }, reversed: val('false') } },
    thin: { solid: {} },
    operation: { op: val('"new"'), targets: { all: {} }, keepTools: val('false') },
  });
  return {
    format: 'tweakcad.document',
    schemaVersion: 2,
    namingRules: 1,
    id: id('doc', 1),
    metadata: {
      name: 'Plate',
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
        name: 'Plate',
        parameters: [],
        timeline: [sketch, extrude],
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
    names: names.toJson(),
  };
}

function at(points: Json[], pid: string): readonly [number, number] {
  const p = points.find((q) => q.id === pid) as Json;
  return [p.x as number, p.y as number];
}

function build(doc: Json): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((d) => d.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  expect(ev.pauses).toEqual([]);
  return ev;
}

const faces = (ev: Evaluation): NamedEntity[] =>
  [...(ev.parts.get(PART)?.state.entities.values() ?? [])].filter((e) => e.kind === 'face');
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;

describe('evaluating a version-2 document', () => {
  it('builds the extruded plate with every face named', () => {
    const ev = build(plate(20, '5 mm'));
    const named = faces(ev);
    expect(named).toHaveLength(7); // four walls, the hole's wall, start and end
    expect(named.map((e) => roleOf(ev, e)).sort()).toEqual(['end', 'side', 'side', 'side', 'side', 'side', 'start']);
    const body = [...(ev.parts.get(PART)?.state.entities.values() ?? [])].find((e) => e.kind === 'body') as NamedEntity;
    expect(ev.adapter.measures(body.key).volume).toBeCloseTo(20 * 10 * 5 - Math.PI * 4 * 5, 6);
  });

  it('names each wall after its own sketch curve, even when the hole sits close to a wall', () => {
    // At 9 mm wide the hole's wall passes 2 mm from the right wall.
    const ev = build(plate(9, '5 mm'));
    const walls = faces(ev).filter((e) => roleOf(ev, e) === 'side');
    expect(new Set(walls.map((w) => w.ladder.join())).size).toBe(5);
    const srcRoot = (e: NamedEntity) =>
      (ev.names.get(e.ladder[2] as string) as { src: { id?: { id: string } }[] }).src[0]?.id?.id;
    const hole = walls.find(
      (w) => Math.abs(centroid(ev, w.key)[0] - 5) < 1e-6 && Math.abs(centroid(ev, w.key)[1] - 5) < 1e-6,
    ) as NamedEntity;
    expect(srcRoot(hole)).toBe(id('crv', 9));
    const right = walls.find((w) => Math.abs(centroid(ev, w.key)[0] - 9) < 1e-9) as NamedEntity;
    expect(srcRoot(right)).toBe(id('crv', 2));
  });

  it('keeps a pick on the end face when the extrude gets deeper', () => {
    const before = build(plate(20, '5 mm'));
    const end = faces(before).find((e) => roleOf(before, e) === 'end') as NamedEntity;
    const record = writeRecord(end, before.parts.get(PART)!.state, before.adapter);
    const after = build(plate(20, '8 mm'));
    const found = resolve(record, after.parts.get(PART)!.state, after.adapter);
    expect(found.outcome).toBe('same');
    const key = found.outcome === 'same' ? (found.entities[0]?.key as ShapeKey) : -1;
    expect(centroid(after, key)[2]).toBeCloseTo(8, 9);
  });

  it('keeps a pick on a side wall when a corner moves', () => {
    const before = build(plate(20, '5 mm'));
    const right = faces(before).find(
      (e) => roleOf(before, e) === 'side' && Math.abs(centroid(before, e.key)[0] - 20) < 1e-9,
    ) as NamedEntity;
    const record = writeRecord(right, before.parts.get(PART)!.state, before.adapter);
    const after = build(plate(25, '5 mm'));
    const found = resolve(record, after.parts.get(PART)!.state, after.adapter);
    expect(found.outcome).toBe('same');
    const key = found.outcome === 'same' ? (found.entities[0]?.key as ShapeKey) : -1;
    expect(centroid(after, key)[0]).toBeCloseTo(25, 9);
  });
});

describe('what the reader does not understand, and configurations', () => {
  const timelineOf = (doc: Json) => ((doc.parts as Json[])[0] as Json).timeline as Json[];
  const total = (ev: Evaluation, d: DocBuilder) =>
    [...(ev.parts.get(d.partId)?.state.entities.values() ?? [])]
      .filter((e) => e.kind === 'body')
      .reduce((sum, b) => sum + (ev.adapter.measures(b.key).volume as number), 0);
  const run = (doc: Json) => {
    const ev = evaluateDocument(doc, k);
    builds.push(ev);
    return ev;
  };

  it('pauses a feature of an unknown typeVersion, or with an unknown key in its inputs, and what the part row does not understand', () => {
    const d = new DocBuilder();
    const first = box(d, 10, 10, 10);
    box(d, 2, 2, 2, { at: [20, 0, 0] });

    const newer = structuredClone(d.document());
    (timelineOf(newer)[0] as Json).typeVersion = 2;
    expect(readDocument(JSON.parse(JSON.stringify(newer))).refused).toBe(false);
    const ev = run(newer);
    expect(ev.pauses).toEqual([{ feature: first, message: 'unknown typeVersion 2' }]);
    expect(total(ev, d)).toBeCloseTo(8, 6);

    const unknownKey = structuredClone(d.document());
    ((timelineOf(unknownKey)[0] as Json).inputs as Json).draft = { future: {} };
    expect(run(unknownKey).pauses).toEqual([{ feature: first, message: 'unknown key "draft"' }]);

    const unknownRow = structuredClone(d.document());
    ((unknownRow.parts as Json[])[0] as Json).scale = 2;
    const paused = run(unknownRow);
    expect(paused.pauses).toHaveLength(2);
    expect(total(paused, d)).toBe(0);
  });

  it('replaces the whole inputs through an override with the empty pointer', () => {
    const d = new DocBuilder();
    const feature = box(d, 10, 10, 10);
    const doc = d.document();
    const part = (doc.parts as Json[])[0] as Json;
    const choice = d.id('par');
    part.parameters = [
      {
        id: d.id('tbl'),
        name: 'T',
        parameters: [
          {
            id: choice,
            name: 'size',
            type: 'choice',
            options: ['small', 'large'],
            value: d.val('"small"'),
            range: { unbounded: {} },
            public: false,
            published: false,
            description: '',
          },
        ],
      },
    ];
    const replacement = {
      shape: { box: { width: d.val('4 mm'), depth: d.val('10 mm'), height: d.val('10 mm') } },
      frame: fixedFrame(d),
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    };
    part.configurations = [
      {
        id: d.id('cfg'),
        input: { id: choice },
        rows: [
          {
            option: { equals: { literal: 'small' } },
            overrides: [{ input: { feature: { id: feature }, pointer: '', with: replacement } }],
          },
        ],
      },
    ];
    expect(readDocument(JSON.parse(JSON.stringify(doc))).diagnostics.filter((x) => x.severity !== 'ignore')).toEqual(
      [],
    );
    const ev = run(doc);
    expect(ev.pauses).toEqual([]);
    expect(total(ev, d)).toBeCloseTo(400, 6);
  });
});
