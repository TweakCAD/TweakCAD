/**
 * Patterns and mirrors of features on the real kernel: each copy of a
 * feature's tool applied with that feature's own operation, named with its
 * slot, and picks on copies that keep their face through edits to the count
 * and to the seed feature.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  idItem,
  makeSet,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type JsonValue,
  type NamedEntity,
  type ShapeKey,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { freezeFeature } from './freeze';

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
  const part = ev.parts.get(d.partId)!;
  // Every sub-shape of every live body has a name.
  for (const shape of part.shapes.keys()) {
    const t = ev.adapter.topology(shape);
    const keys = [
      ...t.faces,
      ...t.edges.map((e) => e.edge),
      ...t.vertices.map((v) => v.vertex),
      ...t.solids.map((s) => s.solid),
    ];
    expect(keys.filter((key) => !part.state.entities.has(key))).toEqual([]);
  }
  return ev;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const all = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const faces = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, d: DocBuilder) =>
  bodies(ev, d).reduce((sum, e) => sum + (ev.adapter.measures(e.key).volume as number), 0);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const levelOf = (ev: Evaluation, e: NamedEntity) => ev.names.get(e.ladder[e.ladder.length - 1] as string) as Json;
const keysOf = (ev: Evaluation, e: NamedEntity) => (levelOf(ev, e).chain as Json[]).map((step) => step.key);
const roleOf = (ev: Evaluation, e: NamedEntity) => levelOf(ev, e).role;
const bores = (ev: Evaluation, d: DocBuilder) => faces(ev, d).filter((e) => roleOf(ev, e) === 'bore');
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, stateOf(ev, d), ev.adapter);
const slot = (i: number, j = 0) => ({ slot: { i, j } });
const circleArea = (r: number) => Math.PI * r * r;

/** The entity a pick resolves to in a rebuild; fails unless it is one sure answer. */
function follow(record: EntityRecord, ev: Evaluation, d: DocBuilder): NamedEntity {
  const found = resolve(record, stateOf(ev, d), ev.adapter);
  expect(found.outcome).toBe('same');
  return (found as { entities: readonly NamedEntity[] }).entities[0] as NamedEntity;
}

/** Copies the names a pick from `ev` uses into `d`, as the editor does when it writes a reference. */
function adopt(d: DocBuilder, ev: Evaluation): void {
  for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
}

/** Ids that stay the same from one document to the next. */
const ids = new DocBuilder();
const HP = ids.id('hp');

/** A `width` × 40 plate, `depth` thick, its top face at z = depth. */
function plate(d: DocBuilder, depth = 5, width = 80): string {
  const s = d.sketch('xy', (x) => x.rect(0, 0, width, 40));
  return d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: `${depth} mm` }] });
}

const frameAt = (d: DocBuilder, z: number): Json => ({
  frame: {
    attach: {
      support: [{ standard: { name: 'xy' } }],
      mode: d.val('"plane"'),
      offset: d.val(`placement(vector(0 mm, 0 mm, ${z} mm), rotate(vector(0, 0, 1), 0 deg))`),
      flip: d.val('false'),
    },
  },
});

/** A through hole down from z = `z` at (x, y). */
function hole(d: DocBuilder, x: number, y: number, o: { z?: number; diameter?: string; thread?: Json } = {}): string {
  return d.feature('core.hole', {
    placement: frameAt(d, o.z ?? 5),
    positions: [{ id: HP, at: { at: { v: d.val(`vector(${x} mm, ${y} mm, 0 mm)`) } } }],
    kind: d.val('"simple"'),
    diameter: d.val(o.diameter ?? '6 mm'),
    depth: { throughAll: {} },
    tip: { flat: {} },
    thread: o.thread ?? { none: {} },
  });
}

const axis = (d: DocBuilder, name: 'x' | 'y' | 'z') => ({
  axis: { axis: d.val(`"${name}"`), reversed: d.val('false') },
});
const row = (d: DocBuilder, name: 'x' | 'y' | 'z', count: number, s: string) => ({
  direction: axis(d, name),
  count: d.val(String(count)),
  spacing: { equal: { s: d.val(s) } },
});
const linear = (...directions: Json[]) => ({ linear: { directions } });
const circular = (d: DocBuilder, count: number, angle: string, x: number, y: number) => ({
  circular: {
    axis: { through: { point: { at: { v: d.val(`vector(${x} mm, ${y} mm, 0 mm)`) } }, direction: axis(d, 'z') } },
    count: d.val(String(count)),
    angle: d.val(angle),
    symmetric: d.val('false'),
  },
});
const featureRef = (id: string) => ({ object: { feature: { id } } });

function pattern(d: DocBuilder, features: string[], layout: Json, skip: Json[] = []): string {
  return d.feature('core.pattern', {
    of: { features: makeSet(features.map(featureRef)) },
    layout,
    skip: makeSet(skip),
    vary: [],
    operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
  });
}

function mirror(d: DocBuilder, features: string[], plane: string): string {
  return d.feature('core.mirror', {
    of: { features: makeSet(features.map(featureRef)) },
    plane: { standard: { name: plane } },
    operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
  });
}

/** The bore at `x`, `y`, which must be one face. */
function boreAt(ev: Evaluation, d: DocBuilder, x: number, y = 20): NamedEntity {
  const found = bores(ev, d).filter((e) => Math.hypot(centroid(ev, e.key)[0] - x, centroid(ev, e.key)[1] - y) < 1e-6);
  expect(found).toHaveLength(1);
  return found[0] as NamedEntity;
}

describe('pattern of a hole', () => {
  const holes = (count: number, o: { x?: number; diameter?: string } = {}) => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d, o.x ?? 10, 20, o.diameter ? { diameter: o.diameter } : {});
    pattern(d, [h], linear(row(d, 'x', count, '20 mm')));
    return d;
  };

  it('cuts a copy of the hole at each slot, each bore named as the seed with its slot', () => {
    const d = holes(3);
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(volume(ev, d)).toBeCloseTo(80 * 40 * 5 - 3 * circleArea(3) * 5, 6);
    const [seed, one, two] = [10, 30, 50].map((x) => boreAt(ev, d, x)) as [NamedEntity, NamedEntity, NamedEntity];
    expect([seed, one, two].map((e) => keysOf(ev, e))).toEqual([[], [slot(1)], [slot(2)]]);
    // The copies keep the seed's role and `src`, only the chain differs.
    expect({ ...levelOf(ev, two), chain: [] }).toEqual(levelOf(ev, seed));
    expect(levelOf(ev, two).src).toEqual([idItem(HP)] as unknown as JsonValue);
  });

  it('keeps a pick on the third bore when the count grows, the seed hole widens and the seed moves', () => {
    const d1 = holes(3);
    const before = build(d1);
    const record = pick(before, d1, boreAt(before, d1, 50));

    const d2 = holes(4);
    adopt(d2, before);
    const more = build(d2);
    expect(bores(more, d2)).toHaveLength(4);
    expect(centroid(more, follow(record, more, d2).key)[0]).toBeCloseTo(50, 6);

    const d3 = holes(3, { diameter: '8 mm' });
    adopt(d3, before);
    const wider = build(d3);
    const found = follow(record, wider, d3);
    expect(centroid(wider, found.key)[0]).toBeCloseTo(50, 6);
    expect(wider.adapter.measures(found.key).area).toBeCloseTo(Math.PI * 8 * 5, 6);

    const d4 = holes(3, { x: 14 });
    adopt(d4, before);
    const moved = build(d4);
    expect(centroid(moved, follow(record, moved, d4).key)[0]).toBeCloseTo(54, 6);
  });

  it('loses only the copies a smaller count drops', () => {
    const d1 = holes(4);
    const before = build(d1);
    const [two, three] = [50, 70].map((x) => pick(before, d1, boreAt(before, d1, x))) as [EntityRecord, EntityRecord];
    const d2 = holes(3);
    adopt(d2, before);
    const after = build(d2);
    expect(centroid(after, follow(two, after, d2).key)[0]).toBeCloseTo(50, 6);
    expect(resolve(three, stateOf(after, d2), after.adapter).outcome).toBe('gone');
  });

  it('places copies round a circle and leaves out the skipped slot', () => {
    const d = new DocBuilder();
    plate(d, 5, 80);
    const h = hole(d, 50, 20);
    pattern(d, [h], circular(d, 4, '360 deg', 40, 20), [slot(2)]);
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(80 * 40 * 5 - 3 * circleArea(3) * 5, 6);
    const at = (x: number, y: number) => keysOf(ev, boreAt(ev, d, x, y));
    expect(at(50, 20)).toEqual([]);
    expect(at(40, 30)).toEqual([slot(1)]);
    expect(at(40, 10)).toEqual([slot(3)]);
    expect(bores(ev, d).filter((e) => Math.abs(centroid(ev, e.key)[0] - 30) < 1e-6)).toEqual([]);
  });

  it('mirrors the hole, the copy named with the mirror step', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(-40, 0, 80, 40));
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
    const h = hole(d, 15, 20);
    mirror(d, [h], 'yz');
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(80 * 40 * 5 - 2 * circleArea(3) * 5, 6);
    expect(keysOf(ev, boreAt(ev, d, -15))).toEqual([{ mirror: {} }]);
  });
});

describe('pattern of extrudes and revolves', () => {
  /** A 4 × 4 pocket, 2 deep, in the plate's top at (x, 18). */
  const pocket = (d: DocBuilder, x: number, depth = '2 mm'): string => {
    const s = d.sketch('xy', (y) => y.rect(x, 18, 4, 4), 5);
    return d.extrude({
      sketch: s.feature,
      profiles: [s.region([x + 1, 19])],
      sides: [{ distance: depth }],
      op: 'cut',
      reversed: true,
    });
  };
  /** A 4 × 4 boss, 3 tall, on the plate's top at (x, 18). */
  const boss = (d: DocBuilder, x: number): string => {
    const s = d.sketch('xy', (y) => y.rect(x, 18, 4, 4), 5);
    return d.extrude({
      sketch: s.feature,
      profiles: [s.region([x + 1, 19])],
      sides: [{ distance: '3 mm' }],
      op: 'join',
    });
  };
  const floorAt = (ev: Evaluation, d: DocBuilder, x: number, z: number) => {
    const found = faces(ev, d).filter((e) => {
      const c = centroid(ev, e.key);
      return ev.adapter.measures(e.key).surface === 'plane' && Math.hypot(c[0] - x, c[1] - 20, c[2] - z) < 1e-6;
    });
    expect(found).toHaveLength(1);
    return found[0] as NamedEntity;
  };

  it('cuts copies of a pocket, and a pick on a copy floor follows a deeper seed', () => {
    const make = (depth: string) => {
      const d = new DocBuilder();
      plate(d);
      pattern(d, [pocket(d, 8, depth)], linear(row(d, 'x', 3, '15 mm')));
      return d;
    };
    const d1 = make('2 mm');
    const before = build(d1);
    expect(volume(before, d1)).toBeCloseTo(80 * 40 * 5 - 3 * 16 * 2, 6);
    const floor = floorAt(before, d1, 40, 3);
    expect(keysOf(before, floor)).toEqual([slot(2)]);
    const record = pick(before, d1, floor);
    const d2 = make('3 mm');
    adopt(d2, before);
    const after = build(d2);
    const c = centroid(after, follow(record, after, d2).key);
    expect([c[0], c[2]]).toEqual([expect.closeTo(40, 6), expect.closeTo(2, 6)]);
  });

  it('joins copies of a boss into the plate', () => {
    const d = new DocBuilder();
    plate(d);
    pattern(d, [boss(d, 8)], linear(row(d, 'x', 3, '15 mm')));
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(volume(ev, d)).toBeCloseTo(80 * 40 * 5 + 3 * 16 * 3, 6);
    expect(keysOf(ev, floorAt(ev, d, 25, 8))).toEqual([slot(1)]);
  });

  it('patterns a pocket and a hole together, each copy cutting', () => {
    const d = new DocBuilder();
    plate(d);
    const p = pocket(d, 8);
    const h = hole(d, 10, 30);
    pattern(d, [h, p], linear(row(d, 'x', 2, '30 mm')));
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(80 * 40 * 5 - 2 * (16 * 2 + circleArea(3) * 5), 6);
    expect(keysOf(ev, boreAt(ev, d, 40, 30))).toEqual([slot(1)]);
  });

  it('cuts copies of a revolved groove', () => {
    const d = new DocBuilder();
    plate(d, 10);
    // On the XZ plane sketch y is world −Z; the square, z 8 to 10, turns a quarter about a vertical axis at x = 10.
    const s = d.sketch('xz', (x) => x.rect(12, -10, 2, 2));
    const groove = d.feature('core.revolve', {
      profiles: makeSet([s.region([13, -9])]),
      axis: { through: { point: { at: { v: d.val('vector(10 mm, 0 mm, 0 mm)') } }, direction: axis(d, 'z') } },
      sides: [{ angle: { a: d.val('90 deg') } }],
      thin: { solid: {} },
      operation: { op: d.val('"cut"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    pattern(d, [groove], linear(row(d, 'x', 2, '30 mm')));
    const ev = build(d);
    // Radii 2 to 4 from the axis, 2 tall, a quarter turn.
    const quarterRing = (Math.PI / 4) * (4 * 4 - 2 * 2) * 2;
    expect(volume(ev, d)).toBeCloseTo(80 * 40 * 10 - 2 * quarterRing, 6);
    // Each groove's start lies in the plate's front face; its end and walls are named per slot.
    const ofGroove = faces(ev, d).filter((e) => (levelOf(ev, e).feature as Json).id === groove);
    expect(ofGroove.filter((e) => roleOf(ev, e) === 'end').map((e) => keysOf(ev, e))).toEqual(
      expect.arrayContaining([[], [slot(1)]]),
    );
    expect(ofGroove.filter((e) => roleOf(ev, e) === 'side')).toHaveLength(6);
  });
});

describe('a patterned tapped hole', () => {
  it('carries the cosmetic thread to every copy', () => {
    const d = new DocBuilder();
    plate(d);
    const thread = {
      thread: {
        standard: d.val('"ISO metric"'),
        designation: d.val('"M6"'),
        class: d.val('"6H"'),
        modelled: d.val('false'),
      },
    };
    const h = hole(d, 10, 20, { thread });
    const p = pattern(d, [h], linear(row(d, 'x', 3, '20 mm')));
    const ev = build(d);
    const part = ev.parts.get(d.partId)!;
    const copies = part.threads.get(p) ?? [];
    expect(copies.map((t) => t.start[0])).toEqual([expect.closeTo(30, 9), expect.closeTo(50, 9)]);
    for (const t of copies) {
      const [face] = t.faces.flatMap((f) => stateOf(ev, d).lookup(f.hash));
      expect(face && centroid(ev, face.key)[0]).toBeCloseTo(t.start[0], 6);
      expect(t.designation).toBe('M6');
    }
  });
});

describe('a frozen tapped hole', () => {
  it('keeps its cosmetic thread, and its tool for a pattern of it', () => {
    const d = new DocBuilder();
    plate(d);
    const thread = {
      thread: {
        standard: d.val('"ISO metric"'),
        designation: d.val('"M6"'),
        class: d.val('"6H"'),
        modelled: d.val('false'),
      },
    };
    const h = hole(d, 10, 20, { thread });
    const p = pattern(d, [h], linear(row(d, 'x', 3, '20 mm')));
    const live = build(d);
    const { document } = freezeFeature(d.document(), k, h);
    const frozen = JSON.parse(JSON.stringify(document)) as Json;
    const read = readDocument(frozen);
    expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
    const ev = evaluateDocument(frozen, k);
    builds.push(ev);
    expect(ev.pauses).toEqual([]);
    const part = ev.parts.get(d.partId)!;
    expect(part.threads.get(h)?.map((t) => t.designation)).toEqual(['M6']);
    expect(part.threads.get(p)?.map((t) => t.start[0])).toEqual([expect.closeTo(30, 9), expect.closeTo(50, 9)]);
    expect(volume(ev, d)).toBeCloseTo(volume(live, d), 6);
    expect([10, 30, 50].map((x) => keysOf(ev, boreAt(ev, d, x)))).toEqual([[], [slot(1)], [slot(2)]]);
  });
});

describe('what pauses', () => {
  const pausedWith = (d: DocBuilder, message: RegExp) => {
    const ev = evaluate(d);
    expect(ev.pauses.map((p) => p.message)).toEqual([expect.stringMatching(message)]);
  };

  it('a pattern of a fillet, which has no tool shape', () => {
    const d = new DocBuilder();
    plate(d);
    const before = build(d);
    const edge = all(before, d).find((e) => e.kind === 'edge' && ev3(before, e)) as NamedEntity;
    adopt(d, before);
    const f = d.feature('core.fillet', {
      sets: [
        {
          targets: makeSet([{ entity: pick(before, d, edge) }]),
          radius: { constant: { s: d.val('1 mm') } },
          setback: d.val('0 mm'),
        },
      ],
    });
    pattern(d, [f], linear(row(d, 'y', 2, '10 mm')));
    pausedWith(d, /no tool shape/);
  });

  it('a pattern of an extrude that made a new body', () => {
    const d = new DocBuilder();
    const e = plate(d);
    pattern(d, [e], linear(row(d, 'x', 2, '100 mm')));
    pausedWith(d, /makes a new body/);
  });

  it('a joining copy that meets no body', () => {
    const d = new DocBuilder();
    plate(d);
    const s = d.sketch('xy', (y) => y.rect(8, 18, 4, 4), 5);
    const boss = d.extrude({
      sketch: s.feature,
      profiles: [s.region([9, 19])],
      sides: [{ distance: '3 mm' }],
      op: 'join',
    });
    pattern(d, [boss], linear(row(d, 'x', 2, '100 mm')));
    pausedWith(d, /meets no target/);
  });

  it('features with different operations', () => {
    const d = new DocBuilder();
    plate(d);
    const s = d.sketch('xy', (y) => y.rect(8, 18, 4, 4), 5);
    const boss = d.extrude({
      sketch: s.feature,
      profiles: [s.region([9, 19])],
      sides: [{ distance: '3 mm' }],
      op: 'join',
    });
    const h = hole(d, 40, 20);
    pattern(d, [boss, h], linear(row(d, 'x', 2, '10 mm')));
    pausedWith(d, /different operations/);
  });

  it('a pattern of a feature that paused', () => {
    const d = new DocBuilder();
    plate(d);
    const h = hole(d, 10, 20, { diameter: '0 mm' });
    pattern(d, [h], linear(row(d, 'x', 2, '20 mm')));
    const ev = evaluate(d);
    expect(ev.pauses.map((p) => p.message)).toEqual([
      expect.stringMatching(/no diameter/),
      expect.stringMatching(/did not build/),
    ]);
  });
});

/** A vertical edge of the plate. */
function ev3(ev: Evaluation, e: NamedEntity): boolean {
  const m = ev.adapter.measures(e.key);
  return m.curve === 'line' && Math.abs((m.tangent as Vec3)[2]) > 0.99;
}
