/**
 * Cosmetic threads on the real kernel: a tapped hole drilled with its tap
 * drill and carrying its thread as data on the bore, `core.thread` on a
 * hole's or a shaft's face, picks that keep their face, and what pauses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  idItem,
  ladderOf,
  makeSet,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type ShapeKey,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { CosmeticThread } from './context';

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

function evaluate(d: DocBuilder): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = evaluate(d);
  expect(ev.pauses).toEqual([]);
  return ev;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const all = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const faces = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const volume = (ev: Evaluation, d: DocBuilder) =>
  all(ev, d)
    .filter((e) => e.kind === 'body')
    .reduce((sum, e) => sum + (ev.adapter.measures(e.key).volume as number), 0);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const threadsOf = (ev: Evaluation, d: DocBuilder, feature: string) =>
  ev.parts.get(d.partId)!.threads.get(feature) ?? [];
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, stateOf(ev, d), ev.adapter);
const ref = (record: EntityRecord): Json => ({ entity: record });
/** The faces a thread lies on, in the build. */
const threaded = (ev: Evaluation, d: DocBuilder, t: CosmeticThread) =>
  t.faces.flatMap((f) => stateOf(ev, d).lookup(f.hash));
const radiusOf = (ev: Evaluation, e: NamedEntity) => {
  const { surface } = ev.adapter.faceGeometry(e.key);
  return surface.kind === 'cylinder' ? (surface.radii[0] as number) : NaN;
};

function follow(record: EntityRecord, ev: Evaluation, d: DocBuilder): NamedEntity {
  const found = resolve(record, stateOf(ev, d), ev.adapter);
  expect(found.outcome).toBe('same');
  return (found as { entities: readonly NamedEntity[] }).entities[0] as NamedEntity;
}

function adopt(d: DocBuilder, ev: Evaluation): void {
  for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
}

const ids = new DocBuilder();
const HP = ids.id('hp');

/** A 40 × 40 plate, `depth` thick. */
function plate(d: DocBuilder, depth = 8): void {
  const s = d.sketch('xy', (x) => x.rect(0, 0, 40, 40));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: `${depth} mm` }] });
}

const spec = (d: DocBuilder, designation: string, cls = '6H', standard = 'ISO metric', modelled = false) => ({
  standard: d.val(`"${standard}"`),
  designation: d.val(`"${designation}"`),
  class: d.val(`"${cls}"`),
  modelled: d.val(String(modelled)),
});

/** A hole down from the plate's top at (20, 20), through unless `depth` is given. */
function hole(
  d: DocBuilder,
  o: { thread?: Json; depth?: string; diameter?: string; plateDepth?: number; id?: string } = {},
): string {
  return d.feature('core.hole', {
    placement: {
      frame: {
        attach: {
          support: [{ standard: { name: 'xy' } }],
          mode: d.val('"plane"'),
          offset: d.val(`placement(vector(0 mm, 0 mm, ${o.plateDepth ?? 8} mm), rotate(vector(0, 0, 1), 0 deg))`),
          flip: d.val('false'),
        },
      },
    },
    positions: [{ id: o.id ?? HP, at: { at: { v: d.val('vector(20 mm, 20 mm, 0 mm)') } } }],
    kind: d.val('"simple"'),
    diameter: d.val(o.diameter ?? '6 mm'),
    depth: o.depth ? { distance: { d: d.val(o.depth) } } : { throughAll: {} },
    tip: { flat: {} },
    thread: o.thread ? { thread: o.thread } : { none: {} },
  });
}

function thread(d: DocBuilder, on: Json[], s: Json, length: Json = { full: {} }): string {
  return d.feature('core.thread', { faces: makeSet(on), ...s, length });
}

const boreOf = (ev: Evaluation, d: DocBuilder, feature: string) => {
  const hash = ladderOf(
    { kind: 'face', chain: [], feature, role: 'bore', src: [idItem(HP)] },
    ev.names,
  ).pop() as string;
  return stateOf(ev, d)
    .lookup(hash)
    .filter((e) => e.kind === 'face');
};

describe('a tapped hole', () => {
  it('is drilled with the tap drill and carries its thread on the bore', () => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d, { thread: spec(d, 'M6') });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(40 * 40 * 8 - Math.PI * 2.5 * 2.5 * 8, 6);
    const [t] = threadsOf(ev, d, h) as [CosmeticThread];
    expect(t).toMatchObject({
      standard: 'ISO metric',
      designation: 'M6',
      class: '6H',
      internal: true,
      pitch: 1,
      major: 6,
      length: expect.closeTo(8, 9),
    });
    expect(t.minor).toBeCloseTo(6 - 1.0825318, 6);
    expect(t.pitchDiameter).toBeCloseTo(6 - 0.6495191, 6);
    expect(t.start).toEqual([expect.closeTo(20, 9), expect.closeTo(20, 9), expect.closeTo(8, 9)]);
    expect(t.direction).toEqual([expect.closeTo(0, 12), expect.closeTo(0, 12), -1]);
    const [face] = threaded(ev, d, t);
    expect(face?.key).toBe(boreOf(ev, d, h)[0]?.key);
    expect(radiusOf(ev, face!)).toBeCloseTo(2.5, 9);
  });

  it('takes a fine pitch, drilled at its own tap drill', () => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d, { thread: spec(d, 'M8x1') });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(40 * 40 * 8 - Math.PI * 3.5 * 3.5 * 8, 6);
    const [t] = threadsOf(ev, d, h) as [CosmeticThread];
    expect(t).toMatchObject({ designation: 'M8x1', class: '6H', internal: true, pitch: 1, major: 8 });
    expect(t.minor).toBeCloseTo(8 - 1.0825318, 6);
    expect(t.pitchDiameter).toBeCloseTo(8 - 0.6495191, 6);
    expect(radiusOf(ev, threaded(ev, d, t)[0]!)).toBeCloseTo(3.5, 9);
  });

  it('stores a left hand on its cosmetic thread, and nothing for a right hand', () => {
    const d = new DocBuilder();
    plate(d);
    const left = hole(d, { thread: { ...spec(d, 'M6'), hand: d.val('"left"') } });
    const ev = build(d);
    expect(threadsOf(ev, d, left)[0]).toMatchObject({ designation: 'M6', hand: 'left' });
    const r = new DocBuilder();
    plate(r);
    const right = hole(r, { thread: { ...spec(r, 'M6'), hand: r.val('"right"') } });
    expect(threadsOf(build(r), r, right)[0]).not.toHaveProperty('hand');
  });

  it('threads a blind hole to its depth', () => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d, { thread: spec(d, 'M8x1.25'), depth: '5 mm' });
    const ev = build(d);
    const [t] = threadsOf(ev, d, h) as [CosmeticThread];
    expect(t.length).toBeCloseTo(5, 9);
    expect(radiusOf(ev, threaded(ev, d, t)[0]!)).toBeCloseTo(3.4, 9);
  });

  it('keeps a pick on the bore when the thread size changes, and the bore keeps its name with or without a thread', () => {
    const make = (designation: string | null) => {
      const d = new DocBuilder();
      plate(d);
      // The values are made either way, so every id matches from one document to the next.
      const t = spec(d, designation ?? 'M6');
      const h = hole(d, designation ? { thread: t } : {});
      return { d, h };
    };
    const a = make('M6');
    const before = build(a.d);
    const record = pick(before, a.d, boreOf(before, a.d, a.h)[0]!);
    for (const next of ['M8', null]) {
      const b = make(next);
      adopt(b.d, before);
      const after = build(b.d);
      const found = follow(record, after, b.d);
      expect(radiusOf(after, found)).toBeCloseTo(next ? 3.4 : 3, 9);
      expect(centroid(after, found.key)[0]).toBeCloseTo(20, 9);
    }
  });
});

describe('core.thread', () => {
  /** A cylinder of radius `r`, 12 tall, standing on the xy plane at (20, 20). */
  const shaft = (d: DocBuilder, r: number) => {
    const s = d.sketch('xy', (x) => x.circle(20, 20, r));
    d.extrude({ sketch: s.feature, profiles: [s.region([20, 20])], sides: [{ distance: '12 mm' }] });
  };
  const wallOf = (ev: Evaluation, d: DocBuilder) =>
    faces(ev, d).find((e) => ev.adapter.measures(e.key).surface === 'cylinder') as NamedEntity;

  it('threads a shaft along its whole length, and from an end for a given length', () => {
    const d = new DocBuilder();
    shaft(d, 5);
    const base = build(d);
    adopt(d, base);
    const wall = pick(base, d, wallOf(base, d));
    const top = all(base, d).find((e) => {
      const m = base.adapter.measures(e.key);
      return e.kind === 'edge' && m.curve === 'circle' && Math.abs((m.center as Vec3)[2] - 12) < 1e-9;
    }) as NamedEntity;
    const full = thread(d, [ref(wall)], spec(d, 'M10', '6g'));
    const part = thread(d, [ref(wall)], spec(d, 'M10', '6g'), {
      distance: { d: d.val('4 mm'), from: ref(pick(base, d, top)) },
    });
    const ev = build(d);
    const [whole] = threadsOf(ev, d, full) as [CosmeticThread];
    expect(whole).toMatchObject({ internal: false, pitch: 1.5, length: expect.closeTo(12, 9) });
    const [short] = threadsOf(ev, d, part) as [CosmeticThread];
    expect(short.length).toBe(4);
    expect(short.start[2]).toBeCloseTo(12, 9);
    expect(short.direction[2]).toBeCloseTo(-1, 12);
    // A cosmetic thread changes no geometry and no name.
    expect(threaded(ev, d, short)[0]?.ladder).toEqual(wallOf(base, d).ladder);
  });

  it('threads a plain hole that was drilled at the tap drill', () => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d, { diameter: '10.2 mm' });
    const base = build(d);
    adopt(d, base);
    const t = thread(d, [ref(pick(base, d, boreOf(base, d, h)[0]!))], spec(d, 'M12'));
    const ev = build(d);
    expect(threadsOf(ev, d, t)[0]).toMatchObject({ internal: true, designation: 'M12', length: expect.closeTo(8, 9) });
  });
});

describe('what pauses', () => {
  const pausesOf = (add: (d: DocBuilder, base: Evaluation, h: string) => void) => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d);
    const base = build(d);
    adopt(d, base);
    add(d, base, h);
    return evaluate(d).pauses.map((p) => p.message);
  };
  const boreRef = (d: DocBuilder, base: Evaluation, h: string) => ref(pick(base, d, boreOf(base, d, h)[0]!));

  it('a size, standard or class the table does not hold, or one that does not fit', () => {
    const cases: [(d: DocBuilder, b: Evaluation, h: string) => void, string][] = [
      [
        (d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M6', '6H', 'UNC')),
        'the thread standard "UNC" is not known',
      ],
      [(d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M6x0.5')), '"M6x0.5" is not an ISO metric pitch of M6'],
      [
        (d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M15')),
        'M15 has no coarse pitch; give its pitch, as in "M15x1.5"',
      ],
      [(d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M7.5')), '"M7.5" is not an ISO metric size'],
      [(d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M6', 'H6')), '"H6" is not an ISO tolerance class'],
      [
        (d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M6', '6g')),
        "class 6g is for a shaft's thread, and the face is a hole",
      ],
      [
        (d, b, h) => thread(d, [boreRef(d, b, h)], spec(d, 'M12')),
        'an M12 thread does not fit a face of diameter 6 mm',
      ],
      [
        (d) => hole(d, { thread: spec(d, 'M6', '6g'), id: d.id('hp') }),
        "class 6g is for a shaft's thread, not a hole's",
      ],
    ];
    for (const [add, message] of cases) expect(pausesOf(add)).toEqual([message]);
  });

  it('a thread on a flat face', () => {
    const messages = pausesOf((d, base) => {
      const top = faces(base, d).find((e) => {
        const m = base.adapter.measures(e.key);
        return m.surface === 'plane' && Math.abs((m.centroid as Vec3)[2] - 8) < 1e-9;
      }) as NamedEntity;
      thread(d, [ref(pick(base, d, top))], spec(d, 'M6'));
    });
    expect(messages).toEqual(['a threaded face is not cylindrical']);
  });
});

describe('reading', () => {
  const refused = (add: (d: DocBuilder) => void) => {
    const d = new DocBuilder();
    plate(d);
    add(d);
    const read = readDocument(JSON.parse(JSON.stringify(d.document())));
    return read.diagnostics.filter((x) => x.severity === 'refuse').map((x) => x.path);
  };
  const face = { standard: { name: 'xy' } };

  it('refuses thread inputs of the wrong type or shape', () => {
    expect(refused((d) => thread(d, [], spec(d, 'M6')))).toHaveLength(1);
    expect(refused((d) => thread(d, [face], { ...spec(d, 'M6'), designation: d.val('6 mm') }))).toHaveLength(1);
    expect(
      refused((d) => thread(d, [face], spec(d, 'M6'), { distance: { d: d.val('4 deg'), from: face } })),
    ).toHaveLength(1);
    expect(refused((d) => thread(d, [face], spec(d, 'M6')))).toEqual([]);
  });

  it('takes a hand of right or left, on a thread and on a hole, and refuses one of another type', () => {
    expect(refused((d) => thread(d, [face], { ...spec(d, 'M6'), hand: d.val('"left"') }))).toEqual([]);
    expect(refused((d) => hole(d, { thread: { ...spec(d, 'M6'), hand: d.val('"right"') } }))).toEqual([]);
    expect(refused((d) => hole(d, { thread: { ...spec(d, 'M6'), hand: d.val('true') } }))).toHaveLength(1);
  });

  it('pauses a hand that is neither right nor left', () => {
    const d = new DocBuilder();
    plate(d);
    hole(d, { thread: { ...spec(d, 'M6'), hand: d.val('"middle"') } });
    expect(evaluate(d).pauses).toHaveLength(1);
  });

  it('reads a length kind it does not know as unknown content', () => {
    const d = new DocBuilder();
    plate(d);
    thread(d, [face], spec(d, 'M6'), { half: {} });
    const read = readDocument(JSON.parse(JSON.stringify(d.document())));
    expect(read.diagnostics.map((x) => x.code)).toContain('unknown-variant');
  });
});
