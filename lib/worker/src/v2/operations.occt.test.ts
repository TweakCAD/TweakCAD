/**
 * Operations and directions on the real kernel that the other suites do not
 * build: an extrude, a revolve and a primitive intersecting the body they
 * meet, which keeps its identity; a cut or intersect from a sketch on the
 * block's top face, which pauses when it runs away from the block; a
 * symmetric extrude measured by its half; and extrudes along a vector and a
 * standard axis instead of the sketch normal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { makeSet, readDocument, writeRecord, type NamedEntity, type Vec3 } from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { box, cylinder } from './primitivesDocs';
import type { Json } from './context';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function build(d: DocBuilder): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  expect(ev.pauses).toEqual([]);
  return ev;
}

const all = (ev: Evaluation, d: DocBuilder) => [...(ev.parts.get(d.partId)?.state.entities.values() ?? [])];
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const bounds = (ev: Evaluation, e: NamedEntity) => {
  const [min, max] = ev.adapter.measures(e.key).bbox as readonly [Vec3, Vec3];
  return { min, max };
};
const identity = (e: NamedEntity) => JSON.stringify([e.ladder, e.branch]);

const closeVec = (v: readonly number[], want: readonly number[], digits = 6) =>
  v.forEach((c, i) => expect(c).toBeCloseTo(want[i] as number, digits));

/** The one body of a build. */
function only(ev: Evaluation, d: DocBuilder): NamedEntity {
  const found = bodies(ev, d);
  expect(found).toHaveLength(1);
  return found[0] as NamedEntity;
}

/** A 20 × 20 × 10 block from the origin, made by an extrude. */
function block(d: DocBuilder): void {
  const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 20));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm' }] });
}

const operation = (d: DocBuilder, op: string) => ({
  op: d.val(`"${op}"`),
  targets: { all: {} },
  keepTools: d.val('false'),
});

describe('after a paused feature', () => {
  it('the next feature can divide the shape it had divided', () => {
    const d = new DocBuilder();
    const two = d.sketch('xy', (x) => {
      x.rect(0, 0, 10, 10);
      x.rect(30, 0, 10, 10);
    });
    d.extrude({
      sketch: two.feature,
      profiles: [two.region([5, 5]), two.region([35, 5])],
      sides: [{ distance: '10 mm' }],
    });
    const first = evaluateDocument(d.document(), k);
    builds.push(first);
    const body = writeRecord(bodies(first, d)[0] as NamedEntity, first.parts.get(d.partId)!.state, first.adapter);
    for (const name of Object.values(first.names.toJson())) d.names.intern(name);
    // A shell too thick for the body pauses once it has the body on its own.
    d.feature('core.shell', {
      bodies: makeSet([{ entity: body }]),
      remove: makeSet([]),
      thickness: d.val('6 mm'),
      direction: d.val('"inside"'),
    });
    const top = d.sketch('xy', (x) => x.rect(0, 0, 10, 10), 10);
    d.extrude({ sketch: top.feature, profiles: [top.region([5, 5])], sides: [{ distance: '5 mm' }], op: 'join' });
    const ev = evaluateDocument(d.document(), k);
    builds.push(ev);
    expect(ev.pauses.map((p) => p.message)).toEqual(['the shell is too thick for this body']);
    expect(bodies(ev, d)).toHaveLength(2);
  });
});

describe('intersect', () => {
  it('keeps what an extrude shares with the block, and the block keeps its name', () => {
    const plain = new DocBuilder();
    block(plain);
    const before = only(build(plain), plain);

    const d = new DocBuilder();
    block(d);
    // A 10 × 10 square from (15, 15), 20 tall: it overlaps the block by 5 × 5 × 10.
    const s = d.sketch('xy', (x) => x.rect(15, 15, 10, 10));
    d.extrude({ sketch: s.feature, profiles: [s.region([16, 16])], sides: [{ distance: '20 mm' }], op: 'intersect' });
    const ev = build(d);
    const body = only(ev, d);
    expect(volume(ev, body)).toBeCloseTo(5 * 5 * 10, 6);
    closeVec(bounds(ev, body).min, [15, 15, 0]);
    closeVec(bounds(ev, body).max, [20, 20, 10]);
    expect(identity(body)).toBe(identity(before));
  });

  it('keeps what a revolve shares with the block', () => {
    const d = new DocBuilder();
    block(d);
    // A ring from radius 5 to 10, 4 tall at z 2 … 6 on the XZ plane (sketch y is −z), turned a quarter about +z.
    const s = d.sketch('xz', (x) => x.rect(5, -6, 5, 4));
    d.feature('core.revolve', {
      profiles: makeSet([s.region([6, -5])]),
      axis: { along: { ref: { standard: { name: 'z' } }, reversed: d.val('false') } },
      sides: [{ angle: { a: d.val('90 deg') } }],
      thin: { solid: {} },
      operation: operation(d, 'intersect'),
    });
    const ev = build(d);
    const body = only(ev, d);
    // The quarter ring lies in the block's corner quadrant (x, y ≥ 0) wholly.
    expect(volume(ev, body)).toBeCloseTo((Math.PI * (100 - 25) * 4) / 4, 4);
    expect(bounds(ev, body).min[2]).toBeCloseTo(2, 6);
    expect(bounds(ev, body).max[2]).toBeCloseTo(6, 6);
  });

  it('keeps what a primitive shares with the block', () => {
    const d = new DocBuilder();
    block(d);
    // A cylinder of radius 4 centred on the block's corner (20, 20, 5): a quarter of it lies in the block.
    cylinder(d, 4, 10, { at: [20, 20, 5], op: 'intersect' });
    const ev = build(d);
    const body = only(ev, d);
    expect(volume(ev, body)).toBeCloseTo((Math.PI * 16 * 10) / 4, 4);
    closeVec(bounds(ev, body).min, [16, 16, 0], 4);
    closeVec(bounds(ev, body).max, [20, 20, 10], 4);
  });

  it('keeps the shared part of a box primitive with an extruded block', () => {
    const d = new DocBuilder();
    block(d);
    box(d, 10, 10, 30, { at: [0, 0, 0], op: 'intersect' });
    const ev = build(d);
    const body = only(ev, d);
    expect(volume(ev, body)).toBeCloseTo(5 * 5 * 10, 6);
  });
});

describe('a cut or intersect from the top face of a block', () => {
  /** The block with a circle of radius 3 on its top face, across its edge at x 20, extruded by `op`. */
  const onTop = (op: 'cut' | 'intersect', reversed: boolean, side: { distance?: string; throughAll?: true }) => {
    const d = new DocBuilder();
    block(d);
    const s = d.sketch('xy', (x) => x.circle(20, 10, 3), 10);
    d.extrude({ sketch: s.feature, profiles: [s.region([19, 10])], sides: [side], op, reversed });
    return d;
  };
  /** The live shapes of the part, each with its volume and face count. */
  const shapes = (ev: Evaluation, d: DocBuilder) =>
    [...ev.parts.get(d.partId)!.shapes.values()].map((h) => ({
      volume: k.getVolume(h),
      faces: k.getSubShapes(h, 'face').length,
      zmin: k.getBoundingBox(h).zmin,
    }));
  const evaluate = (d: DocBuilder) => {
    const ev = evaluateDocument(d.document(), k);
    builds.push(ev);
    return ev;
  };

  for (const op of ['cut', 'intersect'] as const) {
    for (const side of [{ distance: '12 mm' }, { throughAll: true as const }]) {
      it(`${op} ${side.distance ?? 'through all'} out of the block pauses, the block left whole and unsplit`, () => {
        const d = onTop(op, false, side);
        const ev = evaluate(d);
        expect(ev.pauses.map((p) => p.message)).toEqual(['no target body found to cut or intersect']);
        const [block] = shapes(ev, d);
        expect(shapes(ev, d)).toHaveLength(1);
        expect(block!.volume).toBeCloseTo(4000, 6);
        expect(block!.faces).toBe(6);
      });
    }
  }

  it('flipped into the block, a cut takes the half disc out of it', () => {
    const d = onTop('cut', true, { distance: '12 mm' });
    const ev = build(d);
    expect(shapes(ev, d)).toHaveLength(1);
    expect(volume(ev, only(ev, d))).toBeCloseTo(4000 - Math.PI * 9 * 5, 6);
  });

  it('a body the cut only touches stays as it was, unsplit', () => {
    const d = new DocBuilder();
    block(d);
    // A second block under the first, its top face on the first one's bottom face.
    const under = d.sketch('xy', (x) => x.rect(0, 0, 20, 20), -10);
    d.extrude({ sketch: under.feature, profiles: [under.region([1, 1])], sides: [{ distance: '10 mm' }] });
    // Down through the first block, 10 deep: it ends on the second block's top face.
    const s = d.sketch('xy', (x) => x.circle(10, 10, 3), 10);
    d.extrude({
      sketch: s.feature,
      profiles: [s.region([10, 10])],
      sides: [{ distance: '10 mm' }],
      op: 'cut',
      reversed: true,
    });
    const ev = build(d);
    const found = shapes(ev, d).sort((a, b) => a.zmin - b.zmin);
    expect(found).toHaveLength(2);
    expect(found[0]!.volume).toBeCloseTo(4000, 6);
    expect(found[0]!.faces).toBe(6);
    expect(found[1]!.volume).toBeCloseTo(4000 - Math.PI * 9 * 10, 6);
  });
});

describe('a symmetric extrude by its half', () => {
  it('runs the half each way, twice as long as the same value measured as the total', () => {
    const lengths: number[] = [];
    for (const measure of ['half', 'total'] as const) {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], symmetric: { d: '6 mm', measure } });
      const ev = build(d);
      const body = only(ev, d);
      const { min, max } = bounds(ev, body);
      expect(min[2]).toBeCloseTo(-max[2], 9);
      lengths.push(max[2] - min[2]);
      expect(volume(ev, body)).toBeCloseTo(100 * (max[2] - min[2]), 6);
    }
    expect(lengths[0]).toBeCloseTo(12, 9);
    expect(lengths[1]).toBeCloseTo(6, 9);
  });
});

describe('an extrude off the sketch normal', () => {
  const along = (d: DocBuilder, direction: Json) => {
    const s = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
    d.feature('core.extrude', {
      profiles: makeSet([s.region([1, 1])]),
      sides: [{ extent: { distance: { d: d.val('10 mm') } }, taper: d.val('0 deg') }],
      direction,
      thin: { solid: {} },
      operation: operation(d, 'new'),
    });
  };

  it('slants along a vector, its end cap moved the distance along it', () => {
    const d = new DocBuilder();
    along(d, { vector: { v: d.val('vector(1 mm, 0 mm, 1 mm)'), reversed: d.val('false') } });
    const ev = build(d);
    const body = only(ev, d);
    const step = 10 / Math.SQRT2;
    // A prism: base area times the height the slant reaches.
    expect(volume(ev, body)).toBeCloseTo(100 * step, 6);
    closeVec(bounds(ev, body).min, [0, 0, 0]);
    closeVec(bounds(ev, body).max, [10 + step, 10, step]);
  });

  it('runs along a standard axis, reversed when asked', () => {
    const d = new DocBuilder();
    along(d, { axis: { axis: d.val('"z"'), reversed: d.val('true') } });
    const ev = build(d);
    const body = only(ev, d);
    expect(volume(ev, body)).toBeCloseTo(1000, 6);
    closeVec(bounds(ev, body).min, [0, 0, -10]);
    closeVec(bounds(ev, body).max, [10, 10, 0]);
  });
});
