/**
 * Patterns, mirrors and moves on the real kernel: layouts, copies named with
 * their slot, joins, and picks on copies that keep their entity through
 * count, spacing and upstream edits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
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
import { DocBuilder, type SketchHandle } from './docBuilder';
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
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const faces = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
/** A face's centroid, or the centre of a body's box. */
function centroid(ev: Evaluation, key: ShapeKey): Vec3 {
  const m = ev.adapter.measures(key);
  if (m.centroid) return m.centroid;
  const b = k.getBoundingBox(ev.adapter.handleOf(key));
  return [(b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, (b.zmin + b.zmax) / 2];
}
const level = (ev: Evaluation, e: NamedEntity, n: number) => ev.names.get(e.ladder[n] as string) as Json;
const roleOf = (ev: Evaluation, e: NamedEntity) => level(ev, e, 1).role;
const chainOf = (ev: Evaluation, e: NamedEntity) => level(ev, e, 0).chain as Json[];
const keysOf = (ev: Evaluation, e: NamedEntity) => chainOf(ev, e).map((step) => step.key);
const slot = (i: number, j = 0) => ({ slot: { i, j } });
/** The top-of-extrude face whose centroid is nearest `at` in x and y. */
function topNear(ev: Evaluation, d: DocBuilder, x: number, y = 5): NamedEntity {
  const found = faces(ev, d).filter(
    (e) => roleOf(ev, e) === 'end' && Math.hypot(centroid(ev, e.key)[0] - x, centroid(ev, e.key)[1] - y) < 1e-6,
  );
  expect(found).toHaveLength(1);
  return found[0] as NamedEntity;
}
function pick(ev: Evaluation, d: DocBuilder, e: NamedEntity): EntityRecord {
  return writeRecord(e, stateOf(ev, d), ev.adapter);
}
/** The entity a pick resolves to; fails unless it is one sure answer. */
function found(ev: Evaluation, d: DocBuilder, record: EntityRecord): NamedEntity {
  const r = resolve(record, stateOf(ev, d), ev.adapter);
  expect(r.outcome).toBe('same');
  return (r.outcome === 'same' ? r.entities[0] : undefined) as NamedEntity;
}

interface Seed {
  d: DocBuilder;
  s: SketchHandle;
  extrude: string;
  /** The reference to the extruded body. */
  body: Json;
}

const bodyRef = (d: DocBuilder, region: Json, feature: string): Json => {
  const record = region.entity as EntityRecord;
  const src = (d.names.get(record.id[record.id.length - 1] as string) as { src: never }).src;
  const id = ladderOf({ kind: 'body', chain: [], feature, role: 'body', src }, d.names);
  return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
};

/** A 10 × 10 box of height `depth` with its corner at (`x`, 0). */
function box(depth = '5 mm', x = 0): Seed {
  const d = new DocBuilder();
  const s = d.sketch('xy', (y) => y.rect(x, 0, 10, 10));
  const region = s.region([x + 1, 1]);
  const extrude = d.extrude({ sketch: s.feature, profiles: [region], sides: [{ distance: depth }] });
  return { d, s, extrude, body: bodyRef(d, region, extrude) };
}

/** A cylinder of radius 4 at (`x`, 0), so seam edges are copied too. */
function cylinder(x = 0): Seed {
  const d = new DocBuilder();
  const s = d.sketch('xy', (y) => y.circle(x, 0, 4));
  const region = s.region([x, 0]);
  const extrude = d.extrude({ sketch: s.feature, profiles: [region], sides: [{ distance: '6 mm' }] });
  return { d, s, extrude, body: bodyRef(d, region, extrude) };
}

const axis = (d: DocBuilder, name: 'x' | 'y' | 'z', reversed = false) => ({
  axis: { axis: d.val(`"${name}"`), reversed: d.val(String(reversed)) },
});
const operation = (d: DocBuilder, op = 'new', targets: Json = { all: {} }) => ({
  op: d.val(`"${op}"`),
  targets,
  keepTools: d.val('false'),
});
const row = (d: DocBuilder, name: 'x' | 'y' | 'z', count: number, s: string, symmetric?: boolean) => ({
  direction: axis(d, name),
  count: d.val(String(count)),
  spacing: { equal: { s: d.val(s) } },
  ...(symmetric === undefined ? {} : { symmetric: d.val(String(symmetric)) }),
});
const linear = (...directions: Json[]) => ({ linear: { directions } });
const circular = (
  d: DocBuilder,
  count: number,
  angle = '360 deg',
  around: Json = { standard: { name: 'z' } },
  symmetric = false,
) => ({
  circular: {
    axis: { along: { ref: around, reversed: d.val('false') } },
    count: d.val(String(count)),
    angle: d.val(angle),
    symmetric: d.val(String(symmetric)),
  },
});

function pattern(
  seed: Seed,
  layout: Json,
  more: { op?: string; skip?: Json[]; vary?: Json[]; of?: Json } = {},
): string {
  const { d, body } = seed;
  return d.feature('core.pattern', {
    of: more.of ?? { bodies: makeSet([body]) },
    layout,
    skip: makeSet(more.skip ?? []),
    vary: more.vary ?? [],
    operation: operation(d, more.op),
  });
}

function mirror(seed: Seed, plane: Json, op = 'new'): string {
  const { d, body } = seed;
  return d.feature('core.mirror', { of: { bodies: makeSet([body]) }, plane, operation: operation(d, op) });
}

function move(seed: Seed, transform: string, copy = false, of?: Json): string {
  const { d, body } = seed;
  return d.feature('core.move', {
    of: of ?? { bodies: makeSet([body]) },
    transform: d.val(transform),
    copy: d.val(String(copy)),
  });
}

const shifted = (x: number, y = 0, z = 0) =>
  `placement(vector(${x} mm, ${y} mm, ${z} mm), rotate(vector(0, 0, 1), 0 deg))`;
const turned = (deg: number, x = 0, y = 0, z = 0) =>
  `placement(vector(${x} mm, ${y} mm, ${z} mm), rotate(vector(0, 0, 1), ${deg} deg))`;

/** Takes features appended last and puts them before timeline position `at`. */
function insertEarlier(d: DocBuilder, count: number, at: number): void {
  const timeline = ((d.document().parts as Json[])[0] as Json).timeline as Json[];
  timeline.splice(at, 0, ...timeline.splice(timeline.length - count, count));
}

function suppress(d: DocBuilder, feature: string): void {
  const timeline = ((d.document().parts as Json[])[0] as Json).timeline as Json[];
  (timeline.find((f) => f.id === feature) as Json).suppressed = d.val('true');
}

describe('linear pattern', () => {
  it('makes a row of three boxes, each named as the seed in its slot', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')));
    const ev = build(seed.d);
    const found3 = bodies(ev, seed.d).sort((a, b) => centroid(ev, a.key)[0] - centroid(ev, b.key)[0]);
    expect(found3.map((b) => centroid(ev, b.key)[0])).toEqual([
      expect.closeTo(5, 9),
      expect.closeTo(25, 9),
      expect.closeTo(45, 9),
    ]);
    for (const b of found3) expect(volume(ev, b)).toBeCloseTo(500, 6);
    expect(found3.map((b) => keysOf(ev, b))).toEqual([[], [slot(1)], [slot(2)]]);
    expect(new Set(found3.map((b) => b.ladder.join())).size).toBe(3);
    const seedLevel = level(ev, found3[0] as NamedEntity, 1);
    expect(level(ev, found3[2] as NamedEntity, 1)).toEqual({
      ...seedLevel,
      chain: chainOf(ev, found3[2] as NamedEntity),
    });
  });

  it('makes a 2 × 3 grid, slots by direction', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 2, '15 mm'), row(seed.d, 'y', 3, '12 mm')));
    const ev = build(seed.d);
    const grid = bodies(ev, seed.d);
    expect(grid).toHaveLength(6);
    const at = (i: number, j: number) =>
      grid.find(
        (b) => JSON.stringify(keysOf(ev, b)) === JSON.stringify(i + j === 0 ? [] : [slot(i, j)]),
      ) as NamedEntity;
    expect(centroid(ev, at(1, 2).key)[0]).toBeCloseTo(20, 9);
    expect(centroid(ev, at(1, 2).key)[1]).toBeCloseTo(29, 9);
    expect(centroid(ev, at(0, 1).key)[1]).toBeCloseTo(17, 9);
  });

  it('copies a cylinder, seam and all', () => {
    const seed = cylinder();
    pattern(seed, linear(row(seed.d, 'y', 2, '10 mm')));
    const ev = build(seed.d);
    expect(bodies(ev, seed.d)).toHaveLength(2);
  });

  it('keeps a pick on copy 2 when the count goes to 5 and the spacing changes', () => {
    const grid = (count: number, spacing: string) => {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', count, spacing)));
      return seed.d;
    };
    const d1 = grid(3, '20 mm');
    const before = build(d1);
    const top = topNear(before, d1, 45);
    const face = pick(before, d1, top);
    const edge = pick(before, d1, all(before, d1).find((e) => e.kind === 'edge' && e.body === top.body) as NamedEntity);
    const body = pick(before, d1, bodies(before, d1).find((b) => b.body === top.body) as NamedEntity);

    const d2 = grid(5, '30 mm');
    const after = build(d2);
    expect(bodies(after, d2)).toHaveLength(5);
    const moved = found(after, d2, face);
    expect(centroid(after, moved.key)).toEqual([expect.closeTo(65, 9), expect.closeTo(5, 9), expect.closeTo(5, 9)]);
    expect(found(after, d2, edge).body).toBe(moved.body);
    expect(found(after, d2, body).body).toBe(moved.body);
  });

  it('keeps slots 1 and 2 when the count falls from 5 to 3; slot 4 is gone', () => {
    const grid = (count: number) => {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', count, '20 mm')));
      return seed.d;
    };
    const d1 = grid(5);
    const before = build(d1);
    const [one, two, four] = [25, 45, 85].map((x) => pick(before, d1, topNear(before, d1, x)));
    const d2 = grid(3);
    const after = build(d2);
    expect(centroid(after, found(after, d2, one as EntityRecord).key)[0]).toBeCloseTo(25, 9);
    expect(centroid(after, found(after, d2, two as EntityRecord).key)[0]).toBeCloseTo(45, 9);
    expect(resolve(four as EntityRecord, stateOf(after, d2), after.adapter).outcome).toBe('gone');
  });

  it('keeps a pick on a copy when the seed gets taller', () => {
    const tall = (depth: string) => {
      const seed = box(depth);
      pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')));
      return seed.d;
    };
    const d1 = tall('5 mm');
    const before = build(d1);
    const record = pick(before, d1, topNear(before, d1, 25));
    const d2 = tall('8 mm');
    const after = build(d2);
    expect(centroid(after, found(after, d2, record).key)).toEqual([
      expect.closeTo(25, 9),
      expect.closeTo(5, 9),
      expect.closeTo(8, 9),
    ]);
  });

  it('keeps a pick on a copy when a boss is added to the seed before the pattern', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')));
    const before = build(seed.d);
    const record = pick(
      before,
      seed.d,
      faces(before, seed.d).find(
        (e) => roleOf(before, e) === 'side' && Math.abs(centroid(before, e.key)[0] - 40) < 1e-6,
      ) as NamedEntity,
    );

    const boss = seed.d.sketch('xy', (x) => x.rect(4, 4, 2, 2), 5);
    seed.d.extrude({
      sketch: boss.feature,
      profiles: [boss.region([5, 5])],
      sides: [{ distance: '3 mm' }],
      op: 'join',
    });
    insertEarlier(seed.d, 2, 2);
    const after = build(seed.d);
    expect(bodies(after, seed.d).map((b) => volume(after, b))).toEqual([
      expect.closeTo(512, 6),
      expect.closeTo(512, 6),
      expect.closeTo(512, 6),
    ]);
    expect(centroid(after, found(after, seed.d, record).key)[0]).toBeCloseTo(40, 9);
  });

  it('keeps every edge and vertex pick on a copy when a later feature joins onto that copy', () => {
    const later = (boss: boolean) => {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')));
      if (boss) {
        const b = seed.d.sketch('xy', (x) => x.rect(24, 4, 2, 2), 5);
        seed.d.extrude({ sketch: b.feature, profiles: [b.region([25, 5])], sides: [{ distance: '3 mm' }], op: 'join' });
      }
      return seed.d;
    };
    const place = (ev: Evaluation, e: NamedEntity) => {
      const m = ev.adapter.measures(e.key);
      return (m.midpoint ?? m.point) as Vec3;
    };
    const d1 = later(false);
    const before = build(d1);
    const onCopy = all(before, d1).filter(
      (e) => (e.kind === 'edge' || e.kind === 'vertex') && place(before, e)[0] >= 19,
    );
    expect(onCopy).toHaveLength(20);
    const d2 = later(true);
    const after = build(d2);
    for (const e of onCopy) {
      const moved = found(after, d2, pick(before, d1, e));
      expect(moved.kind).toBe(e.kind);
      expect(place(after, moved)).toEqual(place(before, e).map((v) => expect.closeTo(v, 9)));
    }
  });

  it('keeps edge picks on a copy of a copy, and on a copy of a joined body, when a later feature touches it', () => {
    const place = (ev: Evaluation, e: NamedEntity) => {
      const m = ev.adapter.measures(e.key);
      return (m.midpoint ?? m.point) as Vec3;
    };
    // The seed joined with its own copy has faces of two chains; mirrored, a third step goes on them all.
    const later = (boss: boolean) => {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'y', 2, '5 mm')), { op: 'join' });
      mirror(seed, { standard: { name: 'yz' } });
      if (boss) {
        const b = seed.d.sketch('xy', (x) => x.rect(-6, 6, 2, 2), 5);
        seed.d.extrude({ sketch: b.feature, profiles: [b.region([-5, 7])], sides: [{ distance: '3 mm' }], op: 'join' });
      }
      return seed.d;
    };
    const d1 = later(false);
    const before = build(d1);
    const picks = all(before, d1).filter((e) => (e.kind === 'edge' || e.kind === 'vertex') && place(before, e)[0] < -1);
    expect(picks.length).toBeGreaterThan(0);
    const d2 = later(true);
    const after = build(d2);
    for (const e of picks)
      expect(place(after, found(after, d2, pick(before, d1, e)))).toEqual(
        place(before, e).map((v) => expect.closeTo(v, 9)),
      );

    const deep = (boss: boolean) => {
      const seed = box();
      const inner = pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')));
      const record = seed.body.entity as EntityRecord;
      const id = record.id.map((h) =>
        seed.d.names.intern({
          ...(seed.d.names.get(h) as Json),
          chain: [{ op: { id: inner }, key: slot(1) }],
        } as never),
      );
      pattern(seed, linear(row(seed.d, 'y', 2, '20 mm')), { of: { bodies: makeSet([{ entity: { ...record, id } }]) } });
      if (boss) {
        const b = seed.d.sketch('xy', (x) => x.rect(24, 24, 2, 2), 5);
        seed.d.extrude({
          sketch: b.feature,
          profiles: [b.region([25, 25])],
          sides: [{ distance: '3 mm' }],
          op: 'join',
        });
      }
      return seed.d;
    };
    const d3 = deep(false);
    const first = build(d3);
    const far = all(first, d3).filter((e) => (e.kind === 'edge' || e.kind === 'vertex') && place(first, e)[1] >= 19);
    expect(far).toHaveLength(20);
    const d4 = deep(true);
    const second = build(d4);
    for (const e of far)
      expect(place(second, found(second, d4, pick(first, d3, e)))).toEqual(
        place(first, e).map((v) => expect.closeTo(v, 9)),
      );
  });

  it('patterns two bodies, each with its own slots', () => {
    const seed = box();
    const s2 = seed.d.sketch('xy', (x) => x.rect(0, 30, 10, 10));
    const r2 = s2.region([1, 31]);
    const e2 = seed.d.extrude({ sketch: s2.feature, profiles: [r2], sides: [{ distance: '5 mm' }] });
    pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')), {
      of: { bodies: makeSet([seed.body, bodyRef(seed.d, r2, e2)]) },
    });
    const ev = build(seed.d);
    const four = bodies(ev, seed.d);
    expect(four).toHaveLength(4);
    expect(new Set(four.map((b) => b.ladder.join())).size).toBe(4);
  });

  it('leaves skipped slots empty, and a pick on one is gone', () => {
    const grid = (skip: Json[]) => {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', 4, '20 mm')), { skip });
      return seed.d;
    };
    const d1 = grid([]);
    const before = build(d1);
    const [kept, skipped] = [65, 25].map((x) => pick(before, d1, topNear(before, d1, x)));
    const d2 = grid([slot(1)]);
    const after = build(d2);
    expect(bodies(after, d2)).toHaveLength(3);
    expect(centroid(after, found(after, d2, kept as EntityRecord).key)[0]).toBeCloseTo(65, 9);
    expect(resolve(skipped as EntityRecord, stateOf(after, d2), after.adapter).outcome).toBe('gone');
  });

  it('with a count of one is the seed alone', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 1, '20 mm')), { op: 'join' });
    expect(bodies(build(seed.d), seed.d)).toHaveLength(1);
  });

  it('joins overlapping copies onto the seed, which keeps its identity', () => {
    const plain = box();
    const alone = build(plain.d);
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '5 mm')), { op: 'join' });
    const ev = build(seed.d);
    const [body] = bodies(ev, seed.d);
    expect(bodies(ev, seed.d)).toHaveLength(1);
    expect(volume(ev, body as NamedEntity)).toBeCloseTo(20 * 10 * 5, 6);
    expect(body?.ladder).toEqual(bodies(alone, plain.d)[0]?.ladder);
    expect(body?.aliases).toHaveLength(2);
    expect(faces(ev, seed.d)).toHaveLength(6);
  });

  it('keeps a pick on a copy when the pattern starts to join, through the merged face', () => {
    const row3 = (op: string) => {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', 3, '5 mm')), { op });
      return seed.d;
    };
    const d1 = row3('new');
    const before = build(d1);
    const top = topNear(before, d1, 15);
    const record = pick(before, d1, top);
    const d2 = row3('join');
    const after = build(d2);
    expect(centroid(after, found(after, d2, record).key)).toEqual([
      expect.closeTo(10, 9),
      expect.closeTo(5, 9),
      expect.closeTo(5, 9),
    ]);
  });

  it('leaves copies that touch nothing as bodies under their own names when joining', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')), { op: 'join' });
    const ev = build(seed.d);
    const found3 = bodies(ev, seed.d).sort((a, b) => centroid(ev, a.key)[0] - centroid(ev, b.key)[0]);
    expect(found3.map((b) => keysOf(ev, b))).toEqual([[], [slot(1)], [slot(2)]]);
  });

  it('leaves a body nothing touches alone when joining onto all bodies', () => {
    const named = (join: boolean) => {
      const seed = box();
      const s2 = seed.d.sketch('xy', (x) => x.rect(0, 100, 10, 10));
      seed.d.extrude({ sketch: s2.feature, profiles: [s2.region([1, 101])], sides: [{ distance: '5 mm' }] });
      if (join) pattern(seed, linear(row(seed.d, 'x', 2, '5 mm')), { op: 'join' });
      return seed.d;
    };
    const d1 = named(false);
    const plain = build(d1);
    const d2 = named(true);
    const ev = build(d2);
    expect(
      bodies(ev, d2)
        .map((b) => b.ladder.join())
        .sort(),
    ).toEqual(
      bodies(plain, d1)
        .map((b) => b.ladder.join())
        .sort(),
    );
    const far = bodies(ev, d2).find((b) => centroid(ev, b.key)[1] > 50) as NamedEntity;
    expect(volume(ev, far)).toBeCloseTo(500, 6);
    expect(far.aliases).toEqual([]);
  });

  it('patterns a pattern, the inner step first in the chain', () => {
    const seed = box();
    const inner = pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')));
    const one = bodyRef(seed.d, seed.s.region([1, 1]), seed.extrude);
    const record = one.entity as EntityRecord;
    const names = seed.d.names;
    const copy = record.id.map((h) => {
      const named = names.get(h) as Json;
      return names.intern({ ...named, chain: [{ op: { id: inner }, key: slot(1) }] } as never);
    });
    const copyRef = { entity: { ...record, id: copy } };
    pattern(seed, linear(row(seed.d, 'y', 2, '20 mm')), { of: { bodies: makeSet([copyRef]) } });
    const ev = build(seed.d);
    const found3 = bodies(ev, seed.d);
    expect(found3).toHaveLength(3);
    const twice = found3.find((b) => chainOf(ev, b).length === 2) as NamedEntity;
    expect(keysOf(ev, twice)).toEqual([slot(1), slot(1)]);
    expect(centroid(ev, twice.key)).toEqual([expect.closeTo(25, 9), expect.closeTo(25, 9), expect.closeTo(2.5, 9)]);
  });
});

describe('circular pattern', () => {
  const ring = (count: number, x = 20) => {
    const seed = box('5 mm', x);
    pattern(seed, circular(seed.d, count));
    return seed.d;
  };

  it('spaces six copies evenly round the axis', () => {
    const d = ring(6);
    const ev = build(d);
    const found6 = bodies(ev, d);
    expect(found6).toHaveLength(6);
    const radius = Math.hypot(25, 5);
    const start = Math.atan2(5, 25);
    for (const b of found6) {
      const key = keysOf(ev, b)[0] as { slot: { i: number } } | undefined;
      const a = start + ((key?.slot.i ?? 0) * Math.PI) / 3;
      expect(centroid(ev, b.key)[0]).toBeCloseTo(radius * Math.cos(a), 9);
      expect(centroid(ev, b.key)[1]).toBeCloseTo(radius * Math.sin(a), 9);
    }
  });

  it('puts the last copy at a partial sweep', () => {
    const seed = box('5 mm', 20);
    pattern(seed, circular(seed.d, 3, '90 deg'));
    const ev = build(seed.d);
    const last = bodies(ev, seed.d).find(
      (b) => JSON.stringify(keysOf(ev, b)) === JSON.stringify([slot(2)]),
    ) as NamedEntity;
    expect(centroid(ev, last.key)[0]).toBeCloseTo(-5, 9);
    expect(centroid(ev, last.key)[1]).toBeCloseTo(25, 9);
  });

  it('turns about a straight edge of the part', () => {
    const seed = box();
    const before = build(seed.d);
    const corner = all(before, seed.d).find((e) => {
      if (e.kind !== 'edge') return false;
      const m = before.adapter.measures(e.key).midpoint as Vec3;
      return Math.abs(m[0]) < 1e-9 && Math.abs(m[1]) < 1e-9;
    }) as NamedEntity;
    const ref = pick(before, seed.d, corner);
    for (const named of Object.values(before.names.toJson())) seed.d.names.intern(named);
    expect(ref.id.every((h) => seed.d.names.get(h) !== undefined)).toBe(true);
    pattern(seed, circular(seed.d, 2, '180 deg', { entity: ref }));
    const ev = build(seed.d);
    const copy = bodies(ev, seed.d).find((b) => chainOf(ev, b).length === 1) as NamedEntity;
    expect(centroid(ev, copy.key)).toEqual([expect.closeTo(-5, 9), expect.closeTo(-5, 9), expect.closeTo(2.5, 9)]);
  });

  it('keeps a pick when copies are added, its slot turning to the new spacing', () => {
    const d1 = ring(6);
    const before = build(d1);
    const third = bodies(before, d1).find(
      (b) => JSON.stringify(keysOf(before, b)) === JSON.stringify([slot(3)]),
    ) as NamedEntity;
    const record = pick(before, d1, third);
    const d2 = ring(12);
    const after = build(d2);
    const a = Math.atan2(5, 25) + Math.PI / 2;
    const at = centroid(after, found(after, d2, record).key);
    expect(at[0]).toBeCloseTo(Math.hypot(25, 5) * Math.cos(a), 9);
    expect(at[1]).toBeCloseTo(Math.hypot(25, 5) * Math.sin(a), 9);
  });
});

describe('symmetric pattern', () => {
  const xs = (ev: Evaluation, d: DocBuilder) =>
    bodies(ev, d)
      .map((b) => centroid(ev, b.key)[0])
      .sort((a, b) => a - b);
  const slotOf = (ev: Evaluation, b: NamedEntity) =>
    (keysOf(ev, b)[0] as { slot: { i: number; j: number } } | undefined)?.slot ?? { i: 0, j: 0 };
  const symmetricRow = (count: number, symmetric: boolean, skip: Json[] = [], depth = '5 mm') => {
    const seed = box(depth);
    pattern(seed, linear(row(seed.d, 'x', count, '20 mm', symmetric)), { skip });
    return seed.d;
  };

  it('spreads the count, the seed among it, both ways, the other side at negative slots', () => {
    const d = symmetricRow(5, true);
    const ev = build(d);
    expect(xs(ev, d)).toEqual([-35, -15, 5, 25, 45].map((x) => expect.closeTo(x, 9)));
    for (const b of bodies(ev, d)) expect(centroid(ev, b.key)[0]).toBeCloseTo(5 + 20 * slotOf(ev, b).i, 9);
    expect(new Set(bodies(ev, d).map((b) => b.ladder.join())).size).toBe(5);
  });

  it('puts the extra copy of an even count on the positive side', () => {
    const d = symmetricRow(4, true);
    const ev = build(d);
    expect(xs(ev, d)).toEqual([-15, 5, 25, 45].map((x) => expect.closeTo(x, 9)));
    expect(
      bodies(ev, d)
        .map((b) => slotOf(ev, b).i)
        .sort((a, b) => a - b),
    ).toEqual([-1, 0, 1, 2]);
  });

  it('builds as before with symmetric false or absent', () => {
    for (const symmetric of [false, undefined]) {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', 3, '20 mm', symmetric)));
      expect(xs(build(seed.d), seed.d)).toEqual([5, 25, 45].map((x) => expect.closeTo(x, 9)));
    }
  });

  it('keeps picks on the first side when a direction turns symmetric', () => {
    const d1 = symmetricRow(3, false);
    const before = build(d1);
    const record = pick(before, d1, topNear(before, d1, 45));
    const d2 = symmetricRow(5, true);
    const after = build(d2);
    expect(centroid(after, found(after, d2, record).key)[0]).toBeCloseTo(45, 9);
  });

  it('suppresses a copy on the other side by its negative slot, and a pick on it is gone', () => {
    const d1 = symmetricRow(5, true);
    const before = build(d1);
    const [near, far] = [-15, -35].map((x) => pick(before, d1, topNear(before, d1, x)));
    const d2 = symmetricRow(5, true, [slot(-1)]);
    const after = build(d2);
    expect(xs(after, d2)).toEqual([-35, 5, 25, 45].map((x) => expect.closeTo(x, 9)));
    expect(resolve(near as EntityRecord, stateOf(after, d2), after.adapter).outcome).toBe('gone');
    expect(centroid(after, found(after, d2, far as EntityRecord).key)[0]).toBeCloseTo(-35, 9);
  });

  it('keeps a pick on a copy on the other side when the seed gets taller', () => {
    const d1 = symmetricRow(5, true, [], '5 mm');
    const before = build(d1);
    const top = pick(before, d1, topNear(before, d1, -35));
    const d2 = symmetricRow(5, true, [], '8 mm');
    const after = build(d2);
    expect(centroid(after, found(after, d2, top).key)).toEqual([
      expect.closeTo(-35, 9),
      expect.closeTo(5, 9),
      expect.closeTo(8, 9),
    ]);
  });

  it('makes a grid symmetric in one direction and one-sided in the other', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '15 mm', true), row(seed.d, 'y', 2, '12 mm')));
    const ev = build(seed.d);
    const grid = bodies(ev, seed.d);
    expect(grid.map((b) => slotOf(ev, b)).sort((a, b) => a.i - b.i || a.j - b.j)).toEqual([
      { i: -1, j: 0 },
      { i: -1, j: 1 },
      { i: 0, j: 0 },
      { i: 0, j: 1 },
      { i: 1, j: 0 },
      { i: 1, j: 1 },
    ]);
    for (const b of grid) {
      const { i, j } = slotOf(ev, b);
      expect(centroid(ev, b.key)[0]).toBeCloseTo(5 + 15 * i, 9);
      expect(centroid(ev, b.key)[1]).toBeCloseTo(5 + 12 * j, 9);
    }
  });

  it('turns copies both ways about the axis, the angle their whole spread', () => {
    const seed = box('5 mm', 20);
    pattern(seed, circular(seed.d, 5, '60 deg', { standard: { name: 'z' } }, true));
    const ev = build(seed.d);
    const ring = bodies(ev, seed.d);
    expect(ring.map((b) => slotOf(ev, b).i).sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    const start = Math.atan2(5, 25);
    for (const b of ring) {
      const a = start + (slotOf(ev, b).i * 15 * Math.PI) / 180;
      expect(centroid(ev, b.key)[0]).toBeCloseTo(Math.hypot(25, 5) * Math.cos(a), 9);
      expect(centroid(ev, b.key)[1]).toBeCloseTo(Math.hypot(25, 5) * Math.sin(a), 9);
    }
  });

  it('turns the extra copy of an even count the positive way', () => {
    const seed = box('5 mm', 20);
    pattern(seed, circular(seed.d, 4, '90 deg', { standard: { name: 'z' } }, true));
    const ev = build(seed.d);
    const ring = bodies(ev, seed.d);
    expect(ring.map((b) => slotOf(ev, b).i).sort((a, b) => a - b)).toEqual([-1, 0, 1, 2]);
    const start = Math.atan2(5, 25);
    for (const b of ring) {
      const a = start + (slotOf(ev, b).i * 30 * Math.PI) / 180;
      expect(centroid(ev, b.key)[0]).toBeCloseTo(Math.hypot(25, 5) * Math.cos(a), 9);
    }
  });

  it('pauses a symmetric circular pattern that spreads a full turn', () => {
    const seed = box('5 mm', 20);
    pattern(seed, circular(seed.d, 3, '360 deg', { standard: { name: 'z' } }, true));
    expect(evaluate(seed.d).pauses.map((p) => p.message)).toEqual([expect.stringMatching(/less than a full turn/)]);
  });
});

describe('mirror', () => {
  it('reflects a body about a default plane, named with the mirror step', () => {
    const seed = box('5 mm', 5);
    mirror(seed, { standard: { name: 'yz' } });
    const ev = build(seed.d);
    const two = bodies(ev, seed.d).sort((a, b) => centroid(ev, a.key)[0] - centroid(ev, b.key)[0]);
    expect(two.map((b) => centroid(ev, b.key)[0])).toEqual([expect.closeTo(-10, 9), expect.closeTo(10, 9)]);
    expect(two.map((b) => keysOf(ev, b))).toEqual([[{ mirror: {} }], []]);
    expect(volume(ev, two[0] as NamedEntity)).toBeCloseTo(500, 6);
  });

  it('keeps a pick on the mirrored side when the seed widens', () => {
    const wide = (w: number) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (y) => y.rect(5, 0, w, 10));
      const region = s.region([6, 1]);
      const extrude = d.extrude({ sketch: s.feature, profiles: [region], sides: [{ distance: '5 mm' }] });
      mirror({ d, s, extrude, body: bodyRef(d, region, extrude) }, { standard: { name: 'yz' } });
      return d;
    };
    const d1 = wide(10);
    const before = build(d1);
    const outer = faces(before, d1).find((e) => Math.abs(centroid(before, e.key)[0] + 15) < 1e-9) as NamedEntity;
    const record = pick(before, d1, outer);
    const d2 = wide(14);
    const after = build(d2);
    const moved = found(after, d2, record);
    expect(centroid(after, moved.key)[0]).toBeCloseTo(-19, 9);
    expect(after.adapter.measures(moved.key).normal?.[0]).toBeCloseTo(-1, 9);
  });

  it('joins onto its source, which keeps its identity', () => {
    const plain = box();
    const alone = build(plain.d);
    const seed = box();
    mirror(seed, { standard: { name: 'yz' } }, 'join');
    const ev = build(seed.d);
    const [body] = bodies(ev, seed.d);
    expect(bodies(ev, seed.d)).toHaveLength(1);
    expect(volume(ev, body as NamedEntity)).toBeCloseTo(1000, 6);
    expect(body?.ladder).toEqual(bodies(alone, plain.d)[0]?.ladder);
    expect(body?.aliases).toHaveLength(1);
    expect(faces(ev, seed.d)).toHaveLength(6);
  });

  it('joins onto the bodies named as targets, leaving the rest', () => {
    const seed = box();
    const s2 = seed.d.sketch('xy', (x) => x.rect(-20, 0, 10, 10));
    const r2 = s2.region([-19, 1]);
    const e2 = seed.d.extrude({ sketch: s2.feature, profiles: [r2], sides: [{ distance: '2 mm' }] });
    const target = bodyRef(seed.d, r2, e2);
    seed.d.feature('core.mirror', {
      of: { bodies: makeSet([seed.body]) },
      plane: { standard: { name: 'yz' } },
      operation: operation(seed.d, 'join', { bodies: makeSet([target]) }),
    });
    const ev = build(seed.d);
    const two = bodies(ev, seed.d).sort((a, b) => volume(ev, a) - volume(ev, b));
    expect(two.map((b) => volume(ev, b))).toEqual([expect.closeTo(500, 6), expect.closeTo(700, 6)]);
    expect(two[1]?.ladder).toEqual((target.entity as EntityRecord).id);
  });

  it('reflects about a planar face of the part', () => {
    const seed = box();
    const before = build(seed.d);
    const record = pick(before, seed.d, topNear(before, seed.d, 5));
    for (const named of Object.values(before.names.toJson())) seed.d.names.intern(named);
    mirror(seed, { entity: record });
    const ev = build(seed.d);
    const copy = bodies(ev, seed.d).find((b) => chainOf(ev, b).length === 1) as NamedEntity;
    expect(centroid(ev, copy.key)).toEqual([expect.closeTo(5, 9), expect.closeTo(5, 9), expect.closeTo(7.5, 9)]);
  });

  it('reflects about a construction plane, and pauses on a construction axis', () => {
    const seed = box();
    const offset = (n: number) => seed.d.val(`placement(vector(0 mm, 0 mm, ${n} mm), rotate(vector(1, 0, 0), 0 deg))`);
    const attach = (support: Json, mode: string) => ({
      attach: { support: [support], mode: seed.d.val(`"${mode}"`), offset: offset(15), flip: seed.d.val('false') },
    });
    // The YZ plane moved 15 mm along +x.
    const plane = seed.d.feature('core.constructionPlane', { frame: attach({ standard: { name: 'yz' } }, 'plane') });
    mirror(seed, { object: { feature: { id: plane } } });
    const ev = build(seed.d);
    const copy = bodies(ev, seed.d).find((b) => chainOf(ev, b).length === 1) as NamedEntity;
    expect(centroid(ev, copy.key)).toEqual([expect.closeTo(25, 9), expect.closeTo(5, 9), expect.closeTo(2.5, 9)]);

    const other = box();
    const axisFeature = other.d.feature('core.constructionAxis', {
      frame: {
        attach: {
          support: [{ standard: { name: 'x' } }],
          mode: other.d.val('"alongLine"'),
          offset: offset(0),
          flip: other.d.val('false'),
        },
      },
    });
    const id = mirror(other, { object: { feature: { id: axisFeature } } });
    expect(evaluate(other.d).pauses).toEqual([{ feature: id, message: expect.stringMatching(/not a mirror plane/) }]);
  });
});

describe('move', () => {
  it('only carries names: body and faces keep theirs at the new place', () => {
    const seed = box();
    const before = build(seed.d);
    const [body] = bodies(before, seed.d);
    const top = pick(before, seed.d, topNear(before, seed.d, 5));
    const ladders = all(before, seed.d)
      .map((e) => e.ladder.join())
      .sort();
    const moved = box();
    move(moved, turned(90, 30, 0, 2));
    const ev = build(moved.d);
    const [after] = bodies(ev, moved.d);
    expect(after?.ladder).toEqual(body?.ladder);
    expect(
      all(ev, moved.d)
        .map((e) => e.ladder.join())
        .sort(),
    ).toEqual(ladders);
    expect(centroid(ev, (after as NamedEntity).key)).toEqual([
      expect.closeTo(25, 9),
      expect.closeTo(5, 9),
      expect.closeTo(4.5, 9),
    ]);
    expect(centroid(ev, found(ev, moved.d, top).key)).toEqual([
      expect.closeTo(25, 9),
      expect.closeTo(5, 9),
      expect.closeTo(7, 9),
    ]);
  });

  it('with no motion changes nothing', () => {
    const seed = box();
    move(seed, shifted(0));
    expect(bodies(build(seed.d), seed.d)).toHaveLength(1);
  });

  it('keeps the source and adds a copy in slot 1', () => {
    const seed = box();
    move(seed, shifted(30), true);
    const ev = build(seed.d);
    const two = bodies(ev, seed.d).sort((a, b) => centroid(ev, a.key)[0] - centroid(ev, b.key)[0]);
    expect(two.map((b) => centroid(ev, b.key)[0])).toEqual([expect.closeTo(5, 9), expect.closeTo(35, 9)]);
    expect(two.map((b) => keysOf(ev, b))).toEqual([[], [slot(1)]]);
  });

  it('names a copy the same whether its placement shifts, turns or does both', () => {
    const copied = (transform: string) => {
      const seed = box();
      move(seed, transform, true);
      return seed.d;
    };
    const d1 = copied(shifted(30));
    const before = build(d1);
    const top = topNear(before, d1, 35);
    const edge = all(before, d1).find((e) => e.kind === 'edge' && e.body === top.body) as NamedEntity;
    const records = [pick(before, d1, top), pick(before, d1, edge)];
    for (const transform of [turned(90), turned(90, 30, 0, 2)]) {
      const d2 = copied(transform);
      const after = build(d2);
      const face = found(after, d2, records[0] as EntityRecord);
      expect(after.adapter.measures(face.key).area).toBeCloseTo(100, 9);
      expect(found(after, d2, records[1] as EntityRecord).body).toBe(face.body);
    }
  });

  it('feeds a pattern, whose copies start from the moved body', () => {
    const seed = box();
    move(seed, shifted(100));
    pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')));
    const ev = build(seed.d);
    const xs = bodies(ev, seed.d)
      .map((b) => centroid(ev, b.key)[0])
      .sort((a, b) => a - b);
    expect(xs).toEqual([expect.closeTo(105, 9), expect.closeTo(125, 9)]);
  });
});

describe('what pauses', () => {
  const pausedWith = (d: DocBuilder, message: RegExp) => {
    const ev = evaluate(d);
    expect(ev.pauses).toHaveLength(1);
    expect(ev.pauses[0]?.message).toMatch(message);
    return ev;
  };

  it('a pattern whose source body is gone', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')));
    suppress(seed.d, seed.extrude);
    pausedWith(seed.d, /source body is gone/);
  });

  it('a mirror and a move whose source body is gone', () => {
    const seed = box();
    mirror(seed, { standard: { name: 'yz' } });
    move(seed, shifted(1));
    suppress(seed.d, seed.extrude);
    const ev = evaluate(seed.d);
    expect(ev.pauses.map((p) => p.message)).toEqual([expect.stringMatching(/gone/), expect.stringMatching(/gone/)]);
  });

  it('a mirror on a plane that is not one', () => {
    const seed = box();
    mirror(seed, { standard: { name: 'x' } });
    pausedWith(seed.d, /not a plane/);
  });

  it('patterns and mirrors that cut or intersect, and copies of faces', () => {
    for (const op of ['cut', 'intersect']) {
      const seed = box();
      pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')), { op });
      pausedWith(seed.d, new RegExp(`operation ${op} is not built yet`));
      const other = box();
      mirror(other, { standard: { name: 'yz' } }, op);
      pausedWith(other.d, new RegExp(`operation ${op} is not built yet`));
    }
    const faces = box();
    pattern(faces, linear(row(faces.d, 'x', 3, '20 mm')), { of: { faces: makeSet([faces.body]) } });
    pausedWith(faces.d, /of faces are not built yet/);
  });

  it('coincident copies', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 2, '0 mm')));
    pausedWith(seed.d, /lands exactly on its source/);
  });

  it('copies one body of a shape holding several', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 10, 10);
      x.rect(20, 0, 10, 10);
    });
    const region = s.region([1, 1]);
    const extrude = d.extrude({
      sketch: s.feature,
      profiles: [region, s.region([21, 1])],
      sides: [{ distance: '5 mm' }],
    });
    pattern({ d, s, extrude, body: bodyRef(d, region, extrude) }, linear(row(d, 'y', 2, '20 mm')));
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(3);
  });

  it('joins onto a shape holding several bodies, one body each', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 3, '20 mm')), { op: 'join' });
    const s2 = seed.d.sketch('xy', (x) => x.rect(0, 30, 10, 10));
    const r2 = s2.region([1, 31]);
    const e2 = seed.d.extrude({ sketch: s2.feature, profiles: [r2], sides: [{ distance: '5 mm' }] });
    pattern({ ...seed, body: bodyRef(seed.d, r2, e2) }, linear(row(seed.d, 'y', 2, '20 mm')), { op: 'join' });
    const ev = build(seed.d);
    expect(bodies(ev, seed.d)).toHaveLength(5);
  });

  it('skipping the seed', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')), { skip: [slot(0)] });
    pausedWith(seed.d, /seed/);
  });

  it('each variant not built yet, all read as valid', () => {
    const cases: [(s: Seed) => void, RegExp][] = [
      [
        (s) =>
          pattern(s, linear(row(s.d, 'x', 2, '20 mm')), {
            of: { features: makeSet([{ object: { feature: { id: s.extrude } } }]) },
          }),
        /makes a new body/,
      ],
      [(s) => pattern(s, linear(row(s.d, 'x', 2, '20 mm')), { of: { faces: makeSet([s.body]) } }), /of faces/],
      [
        (s) => pattern(s, { path: { chain: [], count: s.d.val('2'), spacing: { equal: { s: s.d.val('1 mm') } } } }),
        /path/,
      ],
      [
        (s) => pattern(s, linear({ ...row(s.d, 'x', 2, '20 mm'), spacing: { list: { values: [s.d.val('3 mm')] } } })),
        /listed/,
      ],
      [(s) => pattern(s, linear(row(s.d, 'x', 2, '20 mm')), { op: 'cut' }), /operation cut/],
      [
        (s) =>
          pattern(s, linear(row(s.d, 'x', 2, '20 mm')), {
            vary: [
              {
                value: {
                  target: { value: { id: s.d.id('val') } },
                  def: { expr: { text: '1 mm * i', grammar: 1, refs: {} } },
                },
              },
            ],
          }),
        /per-copy/,
      ],
      [(s) => move(s, shifted(1), false, { faces: makeSet([s.body]) }), /of faces/],
      [
        (s) =>
          s.d.feature('core.move', {
            of: { bodies: makeSet([s.body]) },
            transform: { align: { from: { standard: { name: 'xy' } }, to: { standard: { name: 'xz' } } } },
            copy: s.d.val('false'),
          }),
        /aligning/,
      ],
    ];
    for (const [add, message] of cases) {
      const seed = box();
      add(seed);
      pausedWith(seed.d, message);
    }
  });
});

describe('reading', () => {
  const refused = (add: (s: Seed) => void) => {
    const seed = box();
    add(seed);
    const read = readDocument(JSON.parse(JSON.stringify(seed.d.document())));
    return read.diagnostics.filter((x) => x.severity === 'refuse').map((x) => x.path);
  };

  it('refuses inputs of the wrong type or shape', () => {
    const one = (s: Seed) => row(s.d, 'x', 2, '20 mm');
    expect(refused((s) => pattern(s, linear(row(s.d, 'x', 2, '20 deg'))))).toHaveLength(1);
    expect(refused((s) => pattern(s, linear({ ...one(s), count: s.d.val('2 mm') })))).toHaveLength(1);
    expect(refused((s) => pattern(s, linear(one(s), one(s), one(s))))).toHaveLength(1);
    expect(refused((s) => pattern(s, linear()))).toHaveLength(1);
    expect(refused((s) => pattern(s, circular(s.d, 3, '90 mm')))).toHaveLength(1);
    expect(refused((s) => pattern(s, linear(one(s)), { of: { bodies: makeSet([]) } }))).toHaveLength(1);
    expect(refused((s) => pattern(s, linear(one(s)), { skip: [{ slot: { i: 1.5, j: 0 } }] }))).toHaveLength(1);
    expect(refused((s) => move(s, '3 mm'))).toHaveLength(1);
  });

  it('pauses on a copy key that names no place in a layout', () => {
    const seed = box();
    pattern(seed, linear(row(seed.d, 'x', 2, '20 mm')), { skip: [{ mirror: {} }] });
    const read = readDocument(JSON.parse(JSON.stringify(seed.d.document())));
    expect(read.diagnostics.map((x) => x.code)).toContain('unknown-variant');
  });
});
