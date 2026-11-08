/**
 * Modelled threads on the real kernel: a tapped hole and a threaded shaft
 * over the M3 to M12 sizes, each compared with the volume its ISO 68-1 groove
 * must remove, partial threads, threads that stop inside the material, what
 * the faces are called, and what pauses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  makeSet,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type Vec3,
} from '@tweakcad/format';
import { grooveOf, grooveVolume, type ThreadSpec } from './builders/thread';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { ISO_METRIC, threadSize } from './threadTable';

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
const facesOf = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const bodiesOf = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, d: DocBuilder) =>
  bodiesOf(ev, d).reduce((sum, e) => sum + (ev.adapter.measures(e.key).volume as number), 0);
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, stateOf(ev, d), ev.adapter);
const ref = (record: EntityRecord): Json => ({ entity: record });

function adopt(d: DocBuilder, ev: Evaluation): void {
  for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
}

const spec = (d: DocBuilder, designation: string, cls: string) => ({
  standard: d.val(`"${ISO_METRIC}"`),
  designation: d.val(`"${designation}"`),
  class: d.val(`"${cls}"`),
  modelled: d.val('true'),
});

/** What a thread of the size removes along `length` from a cylinder of `radius`. */
function removes(designation: string, internal: boolean, radius: number, length: number): number {
  const threadSpec: ThreadSpec = {
    standard: ISO_METRIC,
    class: internal ? '6H' : '6g',
    internal,
    size: threadSize(ISO_METRIC, designation),
    modelled: true,
  };
  return grooveVolume(grooveOf(threadSpec, radius, length));
}

/** A plate on the XY plane, `depth` thick, from 0,0 to 60,40. */
function plate(d: DocBuilder, depth: number): void {
  const s = d.sketch('xy', (x) => x.rect(0, 0, 60, 40));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: `${depth} mm` }] });
}

function hole(
  d: DocBuilder,
  plateDepth: number,
  thread: Json,
  o: { depth?: string; at?: [number, number][] } = {},
): string {
  return d.feature('core.hole', {
    placement: {
      frame: {
        attach: {
          support: [{ standard: { name: 'xy' } }],
          mode: d.val('"plane"'),
          offset: d.val(`placement(vector(0 mm, 0 mm, ${plateDepth} mm), rotate(vector(0, 0, 1), 0 deg))`),
          flip: d.val('false'),
        },
      },
    },
    positions: (o.at ?? [[20, 20]]).map(([x, y]) => ({
      id: d.id('hp'),
      at: { at: { v: d.val(`vector(${x} mm, ${y} mm, 0 mm)`) } },
    })),
    kind: d.val('"simple"'),
    diameter: d.val('6 mm'),
    depth: o.depth ? { distance: { d: d.val(o.depth) } } : { throughAll: {} },
    tip: { flat: {} },
    thread: { thread },
  });
}

/** A round shaft of `radius`, `length` long, up from the XY plane. */
function shaft(d: DocBuilder, radius: number, length: number): void {
  const s = d.sketch('xy', (x) => x.circle(0, 0, radius));
  d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: `${length} mm` }] });
}

const cylinderFace = (ev: Evaluation, d: DocBuilder) => {
  const face = facesOf(ev, d).find((f) => ev.adapter.measures(f.key).surface === 'cylinder');
  if (!face) throw new Error('no cylinder');
  return face;
};

/** A shaft with its face threaded from the document before it. */
function threadedShaft(
  make: (d: DocBuilder) => void,
  thread: (d: DocBuilder, face: Json, ev: Evaluation) => void,
): { d: DocBuilder; ev: Evaluation } {
  const first = new DocBuilder();
  make(first);
  const base = build(first);
  const d = new DocBuilder();
  make(d);
  adopt(d, base);
  thread(d, ref(pick(base, first, cylinderFace(base, first))), base);
  return { d, ev: evaluate(d) };
}

/** Size, tap drill, and lengths a swept groove failed at: a hole's, then a shaft's. */
const SIZES: [string, number, number, number][] = [
  ['M3', 2.5, 12, 10],
  ['M4', 3.3, 8, 12],
  ['M5', 4.2, 10, 6],
  ['M6', 5, 20, 10],
  ['M8', 6.8, 8, 12],
  ['M10', 8.5, 16, 16],
  ['M12', 10.2, 6, 10],
  ['M8x1', 7, 8, 12],
  ['M10x1.25', 8.8, 10, 10],
  ['M12x1.5', 10.5, 6, 10],
];

describe('a modelled tapped hole', () => {
  for (const [designation, tap, length] of SIZES) {
    it(`${designation}, ${length} mm through a plate`, { timeout: 60_000 }, () => {
      const d = new DocBuilder();
      plate(d, length);
      hole(d, length, spec(d, designation, '6H'));
      const ev = build(d);
      const drilled = 60 * 40 * length - Math.PI * (tap / 2) ** 2 * length;
      expect(volume(ev, d) / (drilled - removes(designation, true, tap / 2, length))).toBeCloseTo(1, 7);
      expect(bodiesOf(ev, d)).toHaveLength(1);
      expect(ev.parts.get(d.partId)!.threads.size).toBe(0);
    });
  }

  it('stops at the end of a blind bore', { timeout: 60_000 }, () => {
    const d = new DocBuilder();
    plate(d, 20);
    hole(d, 20, spec(d, 'M6', '6H'), { depth: '12 mm' });
    const ev = build(d);
    const drilled = 60 * 40 * 20 - Math.PI * 2.5 ** 2 * 12;
    expect(volume(ev, d) / (drilled - removes('M6', true, 2.5, 12))).toBeCloseTo(1, 7);
  });

  it('threads every position, and a pick on any face finds that face', { timeout: 60_000 }, () => {
    const d = new DocBuilder();
    plate(d, 8);
    hole(d, 8, spec(d, 'M5', '6H'), {
      at: [
        [15, 20],
        [30, 20],
        [45, 20],
      ],
    });
    const ev = build(d);
    const drilled = 60 * 40 * 8 - 3 * Math.PI * 2.1 ** 2 * 8;
    expect(volume(ev, d) / (drilled - 3 * removes('M5', true, 2.1, 8))).toBeCloseTo(1, 7);
    for (const face of facesOf(ev, d)) {
      const found = resolve(pick(ev, d, face), stateOf(ev, d), ev.adapter) as {
        outcome: string;
        entities: readonly NamedEntity[];
      };
      expect(found.outcome).toBe('same');
      expect(found.entities.map((e) => e.key)).toEqual([face.key]);
    }
  });

  it('takes what is left of the groove where a bore breaks out of the body', { timeout: 60_000 }, () => {
    const d = new DocBuilder();
    plate(d, 8);
    hole(d, 8, spec(d, 'M6', '6H'), { at: [[1, 20]] });
    const ev = build(d);
    expect(bodiesOf(ev, d)).toHaveLength(1);
    const drilled = 60 * 40 * 8 - Math.PI * 2.5 ** 2 * 8;
    expect(volume(ev, d)).toBeGreaterThan(drilled);
    expect(volume(ev, d)).toBeLessThan(60 * 40 * 8);
  });

  it('pauses when it is copied, as a copy would have no thread', { timeout: 60_000 }, () => {
    const d = new DocBuilder();
    plate(d, 8);
    const h = hole(d, 8, spec(d, 'M6', '6H'));
    d.feature('core.pattern', {
      of: { features: makeSet([{ object: { feature: { id: h } } }]) },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: d.val('"x"'), reversed: d.val('false') } },
              count: d.val('2'),
              spacing: { equal: { s: d.val('20 mm') } },
            },
          ],
        },
      },
      skip: makeSet([]),
      vary: [],
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    expect(evaluate(d).pauses).not.toEqual([]);
  });
});

describe('a modelled thread on a shaft', () => {
  for (const [designation, , , length] of SIZES) {
    const radius = threadSize(ISO_METRIC, designation).major / 2;
    it(`${designation}, ${length} mm`, { timeout: 60_000 }, () => {
      const { d, ev } = threadedShaft(
        (x) => shaft(x, radius, length),
        (x, face) =>
          void x.feature('core.thread', {
            faces: makeSet([face]),
            ...spec(x, designation, '6g'),
            length: { full: {} },
          }),
      );
      expect(ev.pauses).toEqual([]);
      expect(
        volume(ev, d) / (Math.PI * radius ** 2 * length - removes(designation, false, radius, length)),
      ).toBeCloseTo(1, 7);
      expect(ev.parts.get(d.partId)!.threads.size).toBe(0);
    });
  }

  it('runs a length from one end, and stops inside the material', { timeout: 60_000 }, () => {
    const { d, ev } = threadedShaft(
      (x) => shaft(x, 3, 20),
      (x, face, base) => {
        const end = [...stateOf(base, x).entities.values()].find((e) => {
          const m = base.adapter.measures(e.key);
          return e.kind === 'edge' && m.curve === 'circle' && Math.abs((m.center as Vec3)[2] - 20) < 1e-9;
        });
        const from = ref(writeRecord(end as NamedEntity, stateOf(base, x), base.adapter));
        x.feature('core.thread', {
          faces: makeSet([face]),
          ...spec(x, 'M6', '6g'),
          length: { distance: { d: x.val('8 mm'), from } },
        });
      },
    );
    expect(ev.pauses).toEqual([]);
    expect(volume(ev, d) / (Math.PI * 9 * 20 - removes('M6', false, 3, 8))).toBeCloseTo(1, 7);
  });

  it('takes the part of the groove a thinner shaft reaches', { timeout: 60_000 }, () => {
    const { d, ev } = threadedShaft(
      (x) => shaft(x, 2.9, 10),
      (x, face) =>
        void x.feature('core.thread', { faces: makeSet([face]), ...spec(x, 'M6', '6g'), length: { full: {} } }),
    );
    expect(ev.pauses).toEqual([]);
    expect(volume(ev, d) / (Math.PI * 2.9 ** 2 * 10 - removes('M6', false, 2.9, 10))).toBeCloseTo(1, 7);
  });

  it('keeps a pick on its root through a change of length', { timeout: 60_000 }, () => {
    const make = (length: number) =>
      threadedShaft(
        (x) => shaft(x, 3, length),
        (x, face) =>
          void x.feature('core.thread', { faces: makeSet([face]), ...spec(x, 'M6', '6g'), length: { full: {} } }),
      );
    const a = make(10);
    expect(a.ev.pauses).toEqual([]);
    const root = facesOf(a.ev, a.d).find((f) => {
      if (a.ev.adapter.measures(f.key).surface !== 'cylinder') return false;
      const { surface } = a.ev.adapter.faceGeometry(f.key);
      return surface.kind === 'cylinder' && (surface.radii[0] as number) < 2.6;
    }) as NamedEntity;
    expect(root).toBeDefined();
    const record = pick(a.ev, a.d, root);
    const b = make(11);
    expect(b.ev.pauses).toEqual([]);
    expect(resolve(record, stateOf(b.ev, b.d), b.ev.adapter).outcome).not.toBe('gone');
  });
});

describe('the groove', () => {
  const threadSpec = (internal: boolean): ThreadSpec => ({
    standard: ISO_METRIC,
    class: internal ? '6H' : '6g',
    internal,
    size: threadSize(ISO_METRIC, 'M6'),
    modelled: true,
  });

  it('is the ISO 68-1 profile at the basic diameters', () => {
    const H = (Math.sqrt(3) / 2) * 1;
    const minor = 3 - (5 * H) / 8;
    expect(grooveOf(threadSpec(true), minor, 10)).toMatchObject({
      rootRadius: 3,
      rootHalfWidth: 1 / 16,
      coverHalfWidth: expect.closeTo(3 / 8, 9),
    });
    expect(grooveOf(threadSpec(false), 3, 10)).toMatchObject({
      rootRadius: expect.closeTo(minor, 9),
      rootHalfWidth: 1 / 8,
      coverHalfWidth: expect.closeTo(7 / 16, 9),
    });
  });

  it('has nothing to cut where the cylinder is past the thread', () => {
    expect(() => grooveOf(threadSpec(true), 3, 10)).toThrow(/no groove/);
    expect(() => grooveOf(threadSpec(false), 2.4, 10)).toThrow(/no groove/);
  });
});

describe('a left-handed modelled thread', () => {
  const make = (hand: string | null, length = 10) =>
    threadedShaft(
      (x) => shaft(x, 3, length),
      (x, face) =>
        void x.feature('core.thread', {
          faces: makeSet([face]),
          ...spec(x, 'M6', '6g'),
          ...(hand ? { hand: x.val(`"${hand}"`) } : {}),
          length: { full: {} },
        }),
    );
  const body = (ev: Evaluation, d: DocBuilder) => {
    const handle = ev.parts.get(d.partId)!.shapes.values().next().value;
    if (handle === undefined) throw new Error('no body');
    return handle;
  };
  /** Whether the body holds material at `p`: what is left of a 0.05 mm cube there. */
  const holds = (ev: Evaluation, d: DocBuilder, p: Vec3) => {
    const box = k.makeBox(0.05, 0.05, 0.05);
    const cube = k.translate(box, p[0] - 0.025, p[1] - 0.025, p[2] - 0.025);
    return k.getVolume(k.intersect(body(ev, d), cube)) > 1e-6;
  };

  it('removes the same groove, turning the other way round the axis', { timeout: 60_000 }, () => {
    const right = make(null);
    const left = make('left');
    const explicit = make('right');
    for (const t of [right, left, explicit]) expect(t.ev.pauses).toEqual([]);
    const removed = Math.PI * 9 * 10 - removes('M6', false, 3, 10);
    expect(volume(left.ev, left.d) / removed).toBeCloseTo(1, 7);
    expect(volume(explicit.ev, explicit.d)).toBeCloseTo(volume(right.ev, right.d), 9);
    // The left-handed shaft is the right-handed one reflected in the plane through the axis and x: material at (0, y, z) in one is material at (0, -y, z) in the other.
    const r = 2.6;
    const heights = Array.from({ length: 8 }, (_, i) => 3 + i / 8);
    const at = (t: { ev: Evaluation; d: DocBuilder }, y: number) => heights.map((z) => holds(t.ev, t.d, [0, y, z]));
    expect(at(left, r)).toEqual(at(right, -r));
    expect(at(left, -r)).toEqual(at(right, r));
    expect(at(left, r)).not.toEqual(at(right, r));
    expect(at(right, r)).toContain(true);
    expect(at(right, r)).toContain(false);
  });

  it(
    'names its groove faces as a right-handed one does, and a pick on its root survives a change of length',
    { timeout: 60_000 },
    () => {
      const roles = (t: { ev: Evaluation; d: DocBuilder }) =>
        facesOf(t.ev, t.d)
          .map(
            (f) =>
              (t.ev.names.get(f.ladder[f.ladder.length - 1] as string) ?? {}) as { role?: string; src?: unknown[] },
          )
          // The documents differ by the hand's value, so their ids differ.
          .map((n) => `${n.role}:${JSON.stringify(n.src)}`.replace(/(feat|crv|reg)_[a-z0-9]+/g, '$1'))
          .sort();
      const a = make('left');
      expect(roles(a)).toEqual(roles(make(null)));
      const root = facesOf(a.ev, a.d).find((f) => {
        if (a.ev.adapter.measures(f.key).surface !== 'cylinder') return false;
        const { surface } = a.ev.adapter.faceGeometry(f.key);
        return surface.kind === 'cylinder' && (surface.radii[0] as number) < 2.6;
      }) as NamedEntity;
      const record = pick(a.ev, a.d, root);
      const b = make('left', 11);
      expect(b.ev.pauses).toEqual([]);
      expect(resolve(record, stateOf(b.ev, b.d), b.ev.adapter).outcome).not.toBe('gone');
    },
  );

  it('taps a hole left-handed', { timeout: 60_000 }, () => {
    const d = new DocBuilder();
    plate(d, 8);
    hole(d, 8, { ...spec(d, 'M6', '6H'), hand: d.val('"left"') });
    const ev = build(d);
    const drilled = 60 * 40 * 8 - Math.PI * 2.5 ** 2 * 8;
    expect(volume(ev, d) / (drilled - removes('M6', true, 2.5, 8))).toBeCloseTo(1, 7);
  });
});
