/**
 * Holes and shells on the real kernel: tool shapes and volumes, names per
 * position, picks that keep their face through everyday edits, and the cases
 * that pause.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  finest,
  idItem,
  ladderOf,
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
import { EvaluationService } from './service/service';

type Json = Record<string, unknown>;
let k: OcctKernel;
let gcs: GcsWrapper;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(d: DocBuilder, solve = false): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k, solve ? { solver: gcs } : {});
  builds.push(ev);
  return ev;
}

function build(d: DocBuilder, solve = false): Evaluation {
  const ev = evaluate(d, solve);
  expect(ev.pauses).toEqual([]);
  return ev;
}

/** The part's live timeline, for edits that keep every id, as the editor's do. */
const timelineOf = (d: DocBuilder) => (d.document().parts as Json[])[0]!.timeline as Json[];
const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const all = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const faces = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const body = (ev: Evaluation, d: DocBuilder) => all(ev, d).find((e) => e.kind === 'body') as NamedEntity;
const volume = (ev: Evaluation, d: DocBuilder) =>
  all(ev, d)
    .filter((e) => e.kind === 'body')
    .reduce((sum, e) => sum + (ev.adapter.measures(e.key).volume as number), 0);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const area = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).area as number;
const nameOf = (ev: Evaluation, e: NamedEntity) =>
  ev.names.get(e.ladder[e.ladder.length - 1] as string) as { role?: string; src?: JsonValue[] };
const roleOf = (ev: Evaluation, e: NamedEntity) => nameOf(ev, e)?.role;
const withRole = (ev: Evaluation, d: DocBuilder, role: string) => faces(ev, d).filter((e) => roleOf(ev, e) === role);
const at = (ev: Evaluation, d: DocBuilder, role: string, position: string) =>
  withRole(ev, d, role).filter((e) => JSON.stringify(nameOf(ev, e).src) === JSON.stringify([idItem(position)]));
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, stateOf(ev, d), ev.adapter);

/** The entity a pick resolves to in a rebuild; fails unless it resolves. */
function follow(record: EntityRecord, ev: Evaluation, d: DocBuilder): NamedEntity {
  const found = resolve(record, stateOf(ev, d), ev.adapter);
  expect(found.outcome).toBe('same');
  return (found as { entities: readonly NamedEntity[] }).entities[0] as NamedEntity;
}

/** Copies the names a pick from `ev` uses into `d`, as the editor does when it writes a reference. */
function adopt(d: DocBuilder, ev: Evaluation): void {
  for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
}

const circleArea = (r: number) => Math.PI * r * r;

/** Hole position ids that stay the same from one document to the next. */
const ids = new DocBuilder();
const [HP1, HP2, HP3] = [ids.id('hp'), ids.id('hp'), ids.id('hp')] as [string, string, string];

/** A `width` × 40 plate, `depth` thick, its top face up at z = depth. */
function plate(d: DocBuilder, depth = '5 mm', width = 60): void {
  const s = d.sketch('xy', (x) => x.rect(0, 0, width, 40));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: depth }] });
}

/** A fixed frame at z = `z`, normal +Z: holes run down. */
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

const point = (d: DocBuilder, x: number, y: number): Json => ({ at: { v: d.val(`vector(${x} mm, ${y} mm, 0 mm)`) } });

interface HoleOptions {
  placement: Json;
  /** Hole positions in the placement frame, or points as they are written. */
  positions: { id: string; at: Json; from?: Json[] }[];
  kind?: 'simple' | 'counterbore' | 'countersink';
  diameter?: string;
  depth?: string;
  /** An extent as written, in place of `depth`. */
  extent?: Json;
  tip?: string;
  counterbore?: { diameter: string; depth: string };
  countersink?: { diameter: string; angle: string };
  thread?: Json;
}

function hole(d: DocBuilder, o: HoleOptions): string {
  return d.feature('core.hole', {
    placement: o.placement,
    positions: o.positions,
    kind: d.val(`"${o.kind ?? 'simple'}"`),
    diameter: d.val(o.diameter ?? '6 mm'),
    depth: o.extent ?? (o.depth ? { distance: { d: d.val(o.depth) } } : { throughAll: {} }),
    tip: o.tip ? { angle: { a: d.val(o.tip) } } : { flat: {} },
    ...(o.counterbore
      ? { counterbore: { diameter: d.val(o.counterbore.diameter), depth: d.val(o.counterbore.depth) } }
      : {}),
    ...(o.countersink
      ? { countersink: { diameter: d.val(o.countersink.diameter), angle: d.val(o.countersink.angle) } }
      : {}),
    thread: o.thread ?? { none: {} },
  });
}

function shell(
  d: DocBuilder,
  bodies: Json[],
  remove: Json[],
  thickness: string,
  direction = 'inside',
  outside?: string,
): string {
  return d.feature('core.shell', {
    bodies: makeSet(bodies),
    remove: makeSet(remove),
    thickness: d.val(thickness),
    direction: d.val(`"${direction}"`),
    ...(outside === undefined ? {} : { outsideThickness: d.val(outside) }),
  });
}

describe('hole', () => {
  it('cuts two through holes at two positions and names each bore after its position', () => {
    const d = new DocBuilder();
    plate(d);
    const [a, b] = [d.id('hp'), d.id('hp')];
    hole(d, {
      placement: frameAt(d, 5),
      positions: [
        { id: a, at: point(d, 15, 20) },
        { id: b, at: point(d, 45, 20) },
      ],
    });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 5 - 2 * circleArea(3) * 5, 6);
    expect(at(ev, d, 'bore', a)).toHaveLength(1);
    expect(at(ev, d, 'bore', b)).toHaveLength(1);
    expect(centroid(ev, at(ev, d, 'bore', a)[0]!.key)).toEqual([
      expect.closeTo(15, 6),
      expect.closeTo(20, 6),
      expect.closeTo(2.5, 6),
    ]);
    expect(centroid(ev, at(ev, d, 'bore', b)[0]!.key)[0]).toBeCloseTo(45, 6);
  });

  it('drills blind holes with an angled or a flat tip', () => {
    const blind = (tip?: string) => {
      const d = new DocBuilder();
      plate(d, '20 mm');
      const id = d.id('hp');
      hole(d, {
        placement: frameAt(d, 20),
        positions: [{ id, at: point(d, 30, 20) }],
        depth: '10 mm',
        ...(tip ? { tip } : {}),
      });
      const ev = build(d);
      return { d, ev, id };
    };
    const solid = 60 * 40 * 20;
    const flat = blind();
    expect(volume(flat.ev, flat.d)).toBeCloseTo(solid - circleArea(3) * 10, 6);
    const floor = at(flat.ev, flat.d, 'tip', flat.id);
    expect(floor).toHaveLength(1);
    expect(flat.ev.adapter.measures(floor[0]!.key).surface).toBe('plane');
    expect(centroid(flat.ev, floor[0]!.key)[2]).toBeCloseTo(10, 6);

    const pointed = blind('90 deg');
    expect(volume(pointed.ev, pointed.d)).toBeCloseTo(solid - circleArea(3) * 10 - (circleArea(3) * 3) / 3, 6);
    const cone = at(pointed.ev, pointed.d, 'tip', pointed.id);
    expect(cone).toHaveLength(1);
    expect(pointed.ev.adapter.measures(cone[0]!.key).surface).toBe('cone');
    expect(at(pointed.ev, pointed.d, 'bore', pointed.id)).toHaveLength(1);
  });

  it('places holes on a face, in the frame the face gives, and down its normal', () => {
    const base = (d: DocBuilder) => plate(d, '20 mm');
    const d0 = new DocBuilder();
    base(d0);
    const ev0 = build(d0);
    const side = faces(ev0, d0).find((e) => {
      const c = centroid(ev0, e.key);
      return Math.abs(c[0] - 60) < 1e-6;
    }) as NamedEntity;
    const record = pick(ev0, d0, side);

    const d = new DocBuilder();
    base(d);
    adopt(d, ev0);
    const id = d.id('hp');
    hole(d, { placement: { face: { entity: record } }, positions: [{ id, at: point(d, 20, 10) }], depth: '15 mm' });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 20 - circleArea(3) * 15, 6);
    const bore = at(ev, d, 'bore', id)[0] as NamedEntity;
    // On the +X face the frame's x is the part's y, and y = normal × x is the part's z.
    expect(centroid(ev, bore.key)).toEqual([expect.closeTo(52.5, 6), expect.closeTo(20, 6), expect.closeTo(10, 6)]);
  });

  it('builds a counterbore with volume, wall and floor', () => {
    const d = new DocBuilder();
    plate(d, '10 mm');
    const id = d.id('hp');
    hole(d, {
      placement: frameAt(d, 10),
      positions: [{ id, at: point(d, 30, 20) }],
      kind: 'counterbore',
      counterbore: { diameter: '12 mm', depth: '4 mm' },
    });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 10 - circleArea(6) * 4 - circleArea(3) * 6, 6);
    const parts = at(ev, d, 'counterbore', id);
    expect(parts).toHaveLength(2);
    const floor = parts.find((e) => ev.adapter.measures(e.key).surface === 'plane') as NamedEntity;
    expect(area(ev, floor.key)).toBeCloseTo(circleArea(6) - circleArea(3), 6);
    expect(centroid(ev, floor.key)[2]).toBeCloseTo(6, 6);
    expect(at(ev, d, 'bore', id)).toHaveLength(1);
  });

  it('builds a countersink with volume and a cone', () => {
    const d = new DocBuilder();
    plate(d, '10 mm');
    const id = d.id('hp');
    hole(d, {
      placement: frameAt(d, 10),
      positions: [{ id, at: point(d, 30, 20) }],
      kind: 'countersink',
      countersink: { diameter: '12 mm', angle: '90 deg' },
    });
    const ev = build(d);
    const frustum = (Math.PI * 3 * (36 + 18 + 9)) / 3;
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 10 - frustum - circleArea(3) * 7, 6);
    const cone = at(ev, d, 'countersink', id);
    expect(cone).toHaveLength(1);
    expect(ev.adapter.measures(cone[0]!.key).surface).toBe('cone');
    expect(at(ev, d, 'bore', id)).toHaveLength(1);
  });

  describe('a pick on the second bore', () => {
    const [a, b, c] = [HP1, HP2, HP3];
    const plateWith = (o: { diameter?: string; depth?: string } = {}) => {
      const d = new DocBuilder();
      plate(d, o.depth ?? '5 mm');
      hole(d, {
        placement: frameAt(d, Number((o.depth ?? '5 mm').split(' ')[0])),
        positions: [
          { id: a, at: point(d, 15, 20) },
          { id: b, at: point(d, 45, 20) },
        ],
        diameter: o.diameter ?? '6 mm',
      });
      return d;
    };
    const record = () => {
      const d = plateWith();
      const ev = build(d);
      return pick(ev, d, at(ev, d, 'bore', b)[0] as NamedEntity);
    };

    const stays = (d: DocBuilder, z: number) => {
      const ev = build(d);
      const found = follow(record(), ev, d);
      expect(centroid(ev, found.key)).toEqual([expect.closeTo(45, 6), expect.closeTo(20, 6), expect.closeTo(z, 6)]);
      return { ev, found };
    };

    it('survives a third position added to the same feature', () => {
      const d = plateWith();
      const hole = timelineOf(d).find((f) => f.type === 'core.hole') as Json;
      ((hole.inputs as Json).positions as Json[]).push({ id: c, at: point(d, 30, 30) });
      const { ev } = stays(d, 2.5);
      expect(at(ev, d, 'bore', c)).toHaveLength(1);
      expect(volume(ev, d)).toBeCloseTo(60 * 40 * 5 - 3 * circleArea(3) * 5, 6);
    });

    it('survives a new diameter', () => {
      const { ev, found } = stays(plateWith({ diameter: '10 mm' }), 2.5);
      expect(area(ev, found.key)).toBeCloseTo(Math.PI * 10 * 5, 6);
    });

    it('survives a thicker plate', () => {
      const { ev, found } = stays(plateWith({ depth: '12 mm' }), 6);
      expect(area(ev, found.key)).toBeCloseTo(Math.PI * 6 * 12, 6);
    });

    it('survives a feature inserted before the hole', () => {
      const d = plateWith();
      const s = d.sketch('xy', (x) => x.rect(0, 0, 4, 4), 5);
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '3 mm' }], op: 'join' });
      const timeline = timelineOf(d);
      timeline.splice(
        timeline.findIndex((f) => f.type === 'core.hole'),
        0,
        ...timeline.splice(-2),
      );
      stays(d, 2.5);
    });
  });

  it('keeps a counterbore floor and wall apart through edits', () => {
    const id = HP1;
    const part = (depth: number, wide: string, drop: string) => {
      const d = new DocBuilder();
      plate(d, `${depth} mm`);
      hole(d, {
        placement: frameAt(d, depth),
        positions: [{ id, at: point(d, 30, 20) }],
        kind: 'counterbore',
        counterbore: { diameter: wide, depth: drop },
      });
      return d;
    };
    const d0 = part(10, '12 mm', '4 mm');
    const ev0 = build(d0);
    const both = at(ev0, d0, 'counterbore', id);
    const floor = pick(ev0, d0, both.find((e) => ev0.adapter.measures(e.key).surface === 'plane') as NamedEntity);
    const wall = pick(ev0, d0, both.find((e) => ev0.adapter.measures(e.key).surface === 'cylinder') as NamedEntity);

    for (const d of [
      part(10, '12 mm', '4 mm'),
      part(10, '16 mm', '4 mm'),
      part(10, '12 mm', '7 mm'),
      part(25, '12 mm', '4 mm'),
    ]) {
      const ev = build(d);
      expect(ev.adapter.measures(follow(floor, ev, d).key).surface).toBe('plane');
      expect(ev.adapter.measures(follow(wall, ev, d).key).surface).toBe('cylinder');
    }
  });

  it('follows a sketch point, with a pick on its bore, when a dimension moves it', () => {
    const part = (x: string) => {
      const d = new DocBuilder();
      plate(d, '10 mm');
      let origin = '';
      let target = '';
      const s = d.sketch(
        'xy',
        (y) => {
          origin = y.point(0, 0);
          target = y.point(20, 20);
          y.fixed(origin);
          y.distanceX(origin, target, x);
          y.distanceY(origin, target, '20 mm');
        },
        10,
      );
      const ladder = ladderOf(
        { kind: 'point', chain: [], feature: s.feature, role: 'point', src: [idItem(target)] },
        d.names,
      );
      const id = HP1;
      const ref = { entity: { id: ladder, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
      hole(d, { placement: frameAt(d, 10), positions: [{ id, at: { of: { ref } } }] });
      return { d, id };
    };
    const one = part('20 mm');
    const ev0 = build(one.d, true);
    const bore = at(ev0, one.d, 'bore', one.id)[0] as NamedEntity;
    expect(centroid(ev0, bore.key)[0]).toBeCloseTo(20, 6);
    const record = pick(ev0, one.d, bore);

    const moved = part('35 mm');
    const ev = build(moved.d, true);
    expect(centroid(ev, follow(record, ev, moved.d).key)).toEqual([
      expect.closeTo(35, 6),
      expect.closeTo(20, 6),
      expect.closeTo(5, 6),
    ]);
  });

  it('cuts every body in its way, and names each', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 20));
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
    const t = d.sketch('xy', (x) => x.rect(0, 0, 20, 20), 10);
    d.extrude({ sketch: t.feature, profiles: [t.region([1, 1])], sides: [{ distance: '5 mm' }] });
    const id = d.id('hp');
    hole(d, { placement: frameAt(d, 15), positions: [{ id, at: point(d, 10, 10) }] });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(2 * (400 * 5 - circleArea(3) * 5), 6);
    expect(at(ev, d, 'bore', id)).toHaveLength(2);
  });

  it('stacks a counterbore, a bore and an angled tip into one blind hole', () => {
    const d = new DocBuilder();
    plate(d, '20 mm');
    const id = d.id('hp');
    hole(d, {
      placement: frameAt(d, 20),
      positions: [{ id, at: point(d, 30, 20) }],
      kind: 'counterbore',
      counterbore: { diameter: '12 mm', depth: '4 mm' },
      depth: '10 mm',
      tip: '90 deg',
    });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 20 - circleArea(6) * 4 - circleArea(3) * 6 - circleArea(3), 6);
    expect(at(ev, d, 'counterbore', id)).toHaveLength(2);
    expect(at(ev, d, 'bore', id)).toHaveLength(1);
    expect(at(ev, d, 'tip', id)).toHaveLength(1);
  });

  it('keeps the name of the face it drills', () => {
    const d0 = new DocBuilder();
    plate(d0);
    const ev0 = build(d0);
    const top = pick(ev0, d0, withRole(ev0, d0, 'end')[0] as NamedEntity);
    const d = new DocBuilder();
    plate(d);
    hole(d, { placement: frameAt(d, 5), positions: [{ id: d.id('hp'), at: point(d, 30, 20) }] });
    const ev = build(d);
    expect(area(ev, follow(top, ev, d).key)).toBeCloseTo(60 * 40 - circleArea(3), 6);
  });

  it('keeps two bodies of one shape apart when drilling one', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 10, 10);
      x.rect(20, 0, 10, 10);
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1]), s.region([21, 1])], sides: [{ distance: '5 mm' }] });
    const ev0 = build(d);
    const before = all(ev0, d)
      .filter((e) => e.kind === 'body')
      .map((e) => finest(e.ladder))
      .sort();
    hole(d, { placement: frameAt(d, 5), positions: [{ id: HP1, at: point(d, 5, 5) }] });
    const ev = build(d);
    const after = all(ev, d)
      .filter((e) => e.kind === 'body')
      .map((e) => finest(e.ladder))
      .sort();
    expect(after).toEqual(before);
  });

  it('follows a flipped frame and a tilted one', () => {
    const under = new DocBuilder();
    plate(under, '10 mm');
    hole(under, {
      placement: {
        frame: {
          attach: {
            support: [{ standard: { name: 'xy' } }],
            mode: under.val('"plane"'),
            offset: under.val('placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))'),
            flip: under.val('true'),
          },
        },
      },
      positions: [{ id: HP1, at: point(under, 30, -20) }],
      depth: '4 mm',
    });
    const ev = build(under);
    expect(centroid(ev, at(ev, under, 'bore', HP1)[0]!.key)).toEqual([
      expect.closeTo(30, 6),
      expect.closeTo(20, 6),
      expect.closeTo(2, 6),
    ]);

    const tilted = new DocBuilder();
    plate(tilted, '10 mm');
    hole(tilted, {
      placement: {
        frame: {
          fixed: { placement: tilted.val('placement(vector(30 mm, 20 mm, 10 mm), rotate(vector(1, 0, 0), 30 deg))') },
        },
      },
      positions: [{ id: HP1, at: point(tilted, 0, 0) }],
      depth: '5 mm',
    });
    const ev2 = build(tilted);
    const c = centroid(ev2, at(ev2, tilted, 'bore', HP1)[0]!.key);
    expect(c[0]).toBeCloseTo(30, 6);
    expect(c[1]).toBeGreaterThan(20);
    expect(c[2]).toBeLessThan(10);
  });

  it('starts inside the material, the start cap named with the bore', () => {
    const d = new DocBuilder();
    plate(d, '20 mm');
    hole(d, { placement: frameAt(d, 15), positions: [{ id: HP1, at: point(d, 30, 20) }], depth: '5 mm' });
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 20 - circleArea(3) * 5, 6);
    expect(at(ev, d, 'bore', HP1)).toHaveLength(2);
    expect(at(ev, d, 'tip', HP1)).toHaveLength(1);
  });

  it('cuts two positions whose tools overlap', () => {
    const d = new DocBuilder();
    plate(d);
    hole(d, {
      placement: frameAt(d, 5),
      positions: [
        { id: HP1, at: point(d, 30, 20) },
        { id: HP2, at: point(d, 34, 20) },
      ],
    });
    const ev = build(d);
    const lens = 2 * 9 * Math.acos(2 / 3) - 4 * Math.sqrt(5);
    expect(volume(ev, d)).toBeCloseTo(60 * 40 * 5 - (2 * circleArea(3) - lens) * 5, 4);
    // A seam can leave what remains of a wall as two faces, each with the position's name.
    expect(at(ev, d, 'bore', HP1).length).toBeGreaterThan(0);
    expect(at(ev, d, 'bore', HP2).length).toBeGreaterThan(0);
  });

  it('divides a narrow bar in two, and a pick on one piece stays on it', () => {
    const bar = (length: number) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.rect(0, 0, length, 4));
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
      hole(d, { placement: frameAt(d, 5), positions: [{ id: HP1, at: point(d, 10, 2) }] });
      return d;
    };
    const d0 = bar(20);
    const ev0 = build(d0);
    expect(all(ev0, d0).filter((e) => e.kind === 'body')).toHaveLength(2);
    const left = withRole(ev0, d0, 'end').find((e) => centroid(ev0, e.key)[0] < 10) as NamedEntity;
    const record = pick(ev0, d0, left);
    const d1 = bar(30);
    const ev1 = build(d1);
    expect(centroid(ev1, follow(record, ev1, d1).key)[0]).toBeLessThan(10);
  });

  it('pauses for an unknown thread standard and a depth not built', () => {
    const paused = (o: (d: DocBuilder) => Partial<HoleOptions>) => {
      const d = new DocBuilder();
      plate(d);
      hole(d, { placement: frameAt(d, 5), positions: [{ id: d.id('hp'), at: point(d, 30, 20) }], ...o(d) });
      return evaluate(d).pauses.map((p) => p.message);
    };
    const thread = (d: DocBuilder, modelled: boolean, standard = 'ISO metric'): Json => ({
      thread: {
        standard: d.val(`"${standard}"`),
        designation: d.val('"M6"'),
        class: d.val('"6H"'),
        modelled: d.val(String(modelled)),
      },
    });
    expect(paused((d) => ({ thread: thread(d, false, 'ISO') }))).toEqual(['the thread standard "ISO" is not known']);
    expect(paused(() => ({ extent: { upToNext: {} } }))).toEqual(['this hole depth is not built yet']);
    expect(paused(() => ({ kind: 'counterbore' }))).toEqual(['a counterbore hole needs its counterbore sizes']);
    expect(paused(() => ({ kind: 'counterbore', counterbore: { diameter: '4 mm', depth: '1 mm' } }))).toEqual([
      'the counterbore is not wider than the hole',
    ]);
    expect(
      paused(() => ({ kind: 'counterbore', counterbore: { diameter: '12 mm', depth: '9 mm' }, depth: '8 mm' })),
    ).toEqual(['the hole is not deeper than its counterbore or countersink']);
    expect(paused(() => ({ kind: 'countersink', countersink: { diameter: '5 mm', angle: '90 deg' } }))).toEqual([
      'the countersink is not wider than the hole',
    ]);
    expect(paused(() => ({ kind: 'countersink', countersink: { diameter: '12 mm', angle: '180 deg' } }))).toEqual([
      'a hole cone angle lies between 0 and 180 degrees',
    ]);
    expect(paused(() => ({ depth: '3 mm', tip: '0 deg' }))).toEqual([
      'a hole cone angle lies between 0 and 180 degrees',
    ]);
  });

  it('pauses a through-all hole that points away from every body', () => {
    const d = new DocBuilder();
    plate(d);
    // A frame below the plate, its holes running down, away from it.
    hole(d, { placement: frameAt(d, -1), positions: [{ id: d.id('hp'), at: point(d, 30, 20) }] });
    expect(evaluate(d).pauses.map((p) => p.message)).toEqual(['a through-all hole points away from every body']);
  });

  describe('a position measured from edges', () => {
    /** A plate from x = `left` to 60, 40 deep and 5 thick, with the picks a hole on its top takes from the build of the plain plate. */
    let made: ReturnType<typeof makeBase> | undefined;
    const makeBase = () => {
      const d0 = new DocBuilder();
      plate(d0);
      const ev0 = build(d0);
      const edgeAt = (x: number, y: number, z: number) =>
        all(ev0, d0).find((e) => {
          const m = ev0.adapter.measures(e.key);
          return (
            e.kind === 'edge' &&
            Math.hypot((m.midpoint as Vec3)[0] - x, (m.midpoint as Vec3)[1] - y, (m.midpoint as Vec3)[2] - z) < 1e-6
          );
        }) as NamedEntity;
      const top = faces(ev0, d0).find((e) => Math.abs(centroid(ev0, e.key)[2] - 5) < 1e-6) as NamedEntity;
      return {
        ev0,
        top: pick(ev0, d0, top),
        left: pick(ev0, d0, edgeAt(0, 20, 5)),
        right: pick(ev0, d0, edgeAt(60, 20, 5)),
        front: pick(ev0, d0, edgeAt(30, 0, 5)),
        bottomLeft: pick(ev0, d0, edgeAt(0, 20, 0)),
      };
    };
    // Built on first use, once the kernel is up.
    const base = new Proxy({} as ReturnType<typeof makeBase>, {
      get: (_, key) => (made ??= makeBase())[key as keyof ReturnType<typeof makeBase>],
    });
    const from = (d: DocBuilder, edges: [EntityRecord, string][]) =>
      edges.map(([edge, dist]) => ({ edge: { entity: edge }, d: d.val(dist) }));
    const drilled = (o: {
      left?: number;
      from: (d: DocBuilder) => Json[];
      at?: [number, number];
      before?: (d: DocBuilder) => void;
    }) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.rect(o.left ?? 0, 0, 60, 40));
      d.extrude({ sketch: s.feature, profiles: [s.region([30, 20])], sides: [{ distance: '5 mm' }] });
      o.before?.(d);
      adopt(d, base.ev0);
      // The position as clicked, in the top face's frame: the part's x and y.
      const [x, y] = o.at ?? [30, 20];
      hole(d, {
        placement: { face: { entity: base.top } },
        positions: [{ id: HP1, at: point(d, x, y), from: o.from(d) }],
        depth: '5 mm',
      });
      return d;
    };
    const boreAt = (d: DocBuilder) => {
      const ev = build(d);
      const bore = at(ev, d, 'bore', HP1)[0] as NamedEntity;
      return { ev, bore, centre: centroid(ev, bore.key) };
    };

    it('sits at its distances from two edges, and follows the face when an edge moves, a pick on its bore with it', () => {
      const two = (d: DocBuilder) =>
        from(d, [
          [base.left, '10 mm'],
          [base.front, '15 mm'],
        ]);
      const first = drilled({ from: two });
      const a = boreAt(first);
      expect(a.centre).toEqual([expect.closeTo(10, 6), expect.closeTo(15, 6), expect.closeTo(2.5, 6)]);
      const record = pick(a.ev, first, a.bore);
      const moved = drilled({ left: -20, from: two });
      const b = boreAt(moved);
      expect(b.centre).toEqual([expect.closeTo(-10, 6), expect.closeTo(15, 6), expect.closeTo(2.5, 6)]);
      expect(follow(record, b.ev, moved).key).toBe(b.bore.key);
    });

    it('keeps the coordinate along a single edge as given', () => {
      const one = (d: DocBuilder) => from(d, [[base.left, '10 mm']]);
      expect(boreAt(drilled({ from: one, at: [30, 25] })).centre).toEqual([
        expect.closeTo(10, 6),
        expect.closeTo(25, 6),
        expect.closeTo(2.5, 6),
      ]);
      expect(boreAt(drilled({ left: -20, from: one, at: [30, 25] })).centre).toEqual([
        expect.closeTo(-10, 6),
        expect.closeTo(25, 6),
        expect.closeTo(2.5, 6),
      ]);
    });

    it('measures into the face from the far edge too', () => {
      const right = (d: DocBuilder) =>
        from(d, [
          [base.right, '12 mm'],
          [base.front, '8 mm'],
        ]);
      expect(boreAt(drilled({ from: right })).centre).toEqual([
        expect.closeTo(48, 6),
        expect.closeTo(8, 6),
        expect.closeTo(2.5, 6),
      ]);
    });

    it('pauses for an edge that is gone, curved, parallel to the other, or not of the face', () => {
      const pauses = (d: DocBuilder) => evaluate(d).pauses.map((p) => p.message);
      const filleted = drilled({
        from: (d) => from(d, [[base.left, '10 mm']]),
        before: (d) => {
          adopt(d, base.ev0);
          d.feature('core.fillet', {
            sets: [
              {
                targets: makeSet([{ entity: base.left }]),
                radius: { constant: { s: d.val('2 mm') } },
                setback: d.val('0 mm'),
              },
            ],
          });
        },
      });
      expect(pauses(filleted)).toEqual(['a hole reference edge is gone']);
      expect(
        pauses(
          drilled({
            from: (d) =>
              from(d, [
                [base.left, '10 mm'],
                [base.right, '10 mm'],
              ]),
          }),
        ),
      ).toEqual(['the two hole reference edges are parallel']);
      expect(pauses(drilled({ from: (d) => from(d, [[base.bottomLeft, '10 mm']]) }))).toEqual([
        'a hole reference edge is not an edge of the hole face',
      ]);

      const d0 = new DocBuilder();
      const disc = (d: DocBuilder) => {
        const s = d.sketch('xy', (x) => x.circle(0, 0, 20));
        d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: '5 mm' }] });
      };
      disc(d0);
      const ev0 = build(d0);
      const rim = all(ev0, d0).find(
        (e) =>
          e.kind === 'edge' &&
          ev0.adapter.measures(e.key).curve === 'circle' &&
          Math.abs((ev0.adapter.measures(e.key).center as Vec3)[2] - 5) < 1e-6,
      ) as NamedEntity;
      const top = faces(ev0, d0).find((e) => Math.abs(centroid(ev0, e.key)[2] - 5) < 1e-6) as NamedEntity;
      const d = new DocBuilder();
      disc(d);
      adopt(d, ev0);
      hole(d, {
        placement: { face: { entity: pick(ev0, d0, top) } },
        positions: [{ id: HP1, at: point(d, 5, 0), from: from(d, [[pick(ev0, d0, rim), '5 mm']]) }],
        depth: '5 mm',
      });
      expect(pauses(d)).toEqual(['a hole reference edge is not straight']);
    });

    it('pauses on a placement frame, which has no face to measure on', () => {
      const d = new DocBuilder();
      plate(d);
      adopt(d, base.ev0);
      hole(d, {
        placement: frameAt(d, 5),
        positions: [{ id: HP1, at: point(d, 30, 20), from: from(d, [[base.left, '10 mm']]) }],
      });
      expect(evaluate(d).pauses.map((p) => p.message)).toEqual(['a hole measured from edges is placed on a face']);
    });
  });

  it('pauses when the face it sits on is gone', () => {
    const boss = (d: DocBuilder, on: boolean) => {
      plate(d);
      const s = d.sketch('xy', (x) => x.rect(10, 10, 20, 20), 5);
      if (on)
        d.extrude({ sketch: s.feature, profiles: [s.region([11, 11])], sides: [{ distance: '3 mm' }], op: 'join' });
    };
    const d0 = new DocBuilder();
    boss(d0, true);
    const ev0 = build(d0);
    const top = faces(ev0, d0).find((e) => Math.abs(centroid(ev0, e.key)[2] - 8) < 1e-6) as NamedEntity;
    const record = pick(ev0, d0, top);
    const d = new DocBuilder();
    boss(d, false);
    adopt(d, ev0);
    hole(d, { placement: { face: { entity: record } }, positions: [{ id: d.id('hp'), at: point(d, 20, 20) }] });
    expect(evaluate(d).pauses.map((p) => p.message)).toEqual(['the hole face is gone']);
  });
});

describe('reading', () => {
  const refusals = (edit: (inputs: Json) => void) => {
    const d = new DocBuilder();
    plate(d);
    hole(d, { placement: frameAt(d, 5), positions: [{ id: HP1, at: point(d, 30, 20) }] });
    edit(timelineOf(d).find((f) => f.type === 'core.hole')!.inputs as Json);
    return readDocument(JSON.parse(JSON.stringify(d.document())))
      .diagnostics.filter((x) => x.severity === 'refuse')
      .map((x) => x.code);
  };

  it('takes a hole as written', () => {
    expect(refusals(() => {})).toEqual([]);
  });

  it('refuses a hole with no position, a position id of another kind, and a value of the wrong quantity', () => {
    expect(refusals((i) => (i.positions = []))).toEqual(['bad-value']);
    expect(refusals((i) => ((i.positions as Json[])[0]!.id = ids.id('pt')))).toEqual(['bad-id']);
    expect(
      refusals((i) => ((i.diameter as Json).def = { expr: { text: '90 deg', grammar: 1, refs: {} } })).length,
    ).toBeGreaterThan(0);
  });

  it('takes a position measured from one or two edges, and refuses none, three, or a distance that is not a length', () => {
    const edge = { edge: { standard: { name: 'x' } }, d: { def: { expr: { text: '5 mm', grammar: 1, refs: {} } } } };
    // Value ids far past the ones the document makes.
    const FAR = Array.from(
      { length: 1000 },
      (
        (far) => () =>
          far.id('val')
      )(new DocBuilder()),
    ).slice(-3);
    const measured = (list: Json[]) => (i: Json) =>
      ((i.positions as Json[])[0]!.from = list.map((e, n) => ({ ...e, d: { ...(e.d as Json), id: FAR[n] } })));
    expect(refusals(measured([edge]))).toEqual([]);
    expect(refusals(measured([edge, edge]))).toEqual([]);
    expect(refusals(measured([]))).toEqual(['bad-value']);
    expect(refusals(measured([edge, edge, edge]))).toEqual(['bad-value']);
    expect(
      refusals(measured([{ ...edge, d: { def: { expr: { text: '5 deg', grammar: 1, refs: {} } } } }])).length,
    ).toBeGreaterThan(0);
  });
});

describe('shell', () => {
  /** A 20 × 20 × `height` box from a sketch on XY, and its top face. */
  const box = (d: DocBuilder, height = 20, width = 20) => {
    const s = d.sketch('xy', (x) => x.rect(0, 0, width, 20));
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: `${height} mm` }] });
  };

  /** Records of a box's body and top face, picked before any shell. */
  const picks = (height = 20, width = 20) => {
    const d = new DocBuilder();
    box(d, height, width);
    const ev = build(d);
    const top = withRole(ev, d, 'end')[0] as NamedEntity;
    const side = faces(ev, d).find((e) => Math.abs(centroid(ev, e.key)[0] - width) < 1e-6) as NamedEntity;
    return { ev, d, body: pick(ev, d, body(ev, d)), top: pick(ev, d, top), side: pick(ev, d, side) };
  };

  const shelled = (thickness: string, height = 20, width = 20, direction = 'inside') => {
    const p = picks();
    const d = new DocBuilder();
    box(d, height, width);
    adopt(d, p.ev);
    shell(d, [{ entity: p.body }], [{ entity: p.top }], thickness, direction);
    return { d, p };
  };

  it("takes a click on an outside shell's preview, which shows only new faces, as the face before the shell it came from", () => {
    const { d, p } = shelled('2 mm', 20, 20, 'outside');
    const doc = d.document();
    const shellId = (((doc.parts as Json[])[0] as Json).timeline as Json[]).at(-1)?.id as string;
    const service = new EvaluationService(k, gcs);
    try {
      const shown = service.evaluate(doc);
      const made = shown.entities.filter((e) => e.kind === 'face' && e.feature === shellId);
      expect(made.length).toBeGreaterThan(0);
      const picked = made.map((e) => service.pick({ key: e.key }, { before: shellId }));
      // Every wall offset from a face, and the rim of the opened top, is taken as that face.
      expect(picked.every((x) => x !== null)).toBe(true);
      const ladders = picked.map((x) =>
        JSON.stringify((x as { reference: { entity: EntityRecord } }).reference.entity.id),
      );
      expect(ladders).toContain(JSON.stringify((p.side as EntityRecord).id));
      expect(ladders).toContain(JSON.stringify((p.top as EntityRecord).id));
    } finally {
      service.release();
    }
  });

  it('hollows one body of a shape holding two, leaving the other as it was', () => {
    const twoBoxes = (d: DocBuilder) => {
      const s = d.sketch('xy', (x) => {
        x.rect(0, 0, 20, 20);
        x.rect(40, 0, 20, 20);
      });
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1]), s.region([41, 1])], sides: [{ distance: '20 mm' }] });
    };
    const d0 = new DocBuilder();
    twoBoxes(d0);
    const ev0 = build(d0);
    const xmin = (ev: Evaluation, e: NamedEntity) => ev.kernel.getBoundingBox(ev.adapter.handleOf(e.key)).xmin;
    const left = all(ev0, d0).find((e) => e.kind === 'body' && xmin(ev0, e) < 20) as NamedEntity;
    const right = all(ev0, d0).find((e) => e.kind === 'body' && xmin(ev0, e) > 20) as NamedEntity;
    const top = withRole(ev0, d0, 'end').find((e) => centroid(ev0, e.key)[0] < 20) as NamedEntity;
    const d = new DocBuilder();
    twoBoxes(d);
    adopt(d, ev0);
    shell(d, [{ entity: pick(ev0, d0, left) }], [{ entity: pick(ev0, d0, top) }], '2 mm');
    const ev = build(d);
    const bodies = all(ev, d).filter((e) => e.kind === 'body');
    expect(bodies).toHaveLength(2);
    const volumes = bodies.map((b) => ev.adapter.measures(b.key).volume as number).sort((a, b) => a - b);
    expect(volumes).toEqual([expect.closeTo(20 * 20 * 20 - 16 * 16 * 18, 6), expect.closeTo(8000, 6)]);
    expect(follow(pick(ev0, d0, right), ev, d).key).toBe(bodies.find((b) => xmin(ev, b) > 20)?.key);
  });

  it('hollows a box through its top', () => {
    const { d } = shelled('2 mm');
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(20 * 20 * 20 - 16 * 16 * 18, 6);
    expect(withRole(ev, d, 'inner')).toHaveLength(5);
    const rim = withRole(ev, d, 'rim');
    expect(rim).toHaveLength(1);
    expect(area(ev, rim[0]!.key)).toBeCloseTo(400 - 256, 6);
    expect(centroid(ev, rim[0]!.key)[2]).toBeCloseTo(20, 6);
  });

  it('keeps a pick on an inner wall and on the rim through a new thickness and a taller box', () => {
    const { d } = shelled('2 mm');
    const ev = build(d);
    const wall = withRole(ev, d, 'inner').find((e) => Math.abs(centroid(ev, e.key)[0] - 18) < 1e-6) as NamedEntity;
    const records = { wall: pick(ev, d, wall), rim: pick(ev, d, withRole(ev, d, 'rim')[0] as NamedEntity) };

    const thicker = shelled('3 mm').d;
    const ev2 = build(thicker);
    expect(centroid(ev2, follow(records.wall, ev2, thicker).key)[0]).toBeCloseTo(17, 6);
    expect(area(ev2, follow(records.rim, ev2, thicker).key)).toBeCloseTo(400 - 14 * 14, 6);

    const taller = shelled('2 mm', 30).d;
    const ev3 = build(taller);
    expect(centroid(ev3, follow(records.wall, ev3, taller).key)[0]).toBeCloseTo(18, 6);
    expect(centroid(ev3, follow(records.rim, ev3, taller).key)[2]).toBeCloseTo(30, 6);
  });

  it('keeps the outer faces named as they were', () => {
    const { d, p } = shelled('2 mm');
    const ev = build(d);
    expect(centroid(ev, follow(p.side, ev, d).key)[0]).toBeCloseTo(20, 6);
  });

  it('removes two faces, one rim each', () => {
    const p = picks();
    const d = new DocBuilder();
    box(d);
    adopt(d, p.ev);
    shell(d, [{ entity: p.body }], [{ entity: p.top }, { entity: p.side }], '2 mm');
    const ev = build(d);
    const rims = withRole(ev, d, 'rim');
    expect(rims).toHaveLength(2);
    expect(finest(rims[0]!.ladder)).not.toEqual(finest(rims[1]!.ladder));
    expect(withRole(ev, d, 'inner')).toHaveLength(4);
  });

  it('grows outward, the original faces staying where they were', () => {
    const { d, p } = shelled('2 mm', 20, 20, 'outside');
    const ev = build(d);
    const outer = 24 * 24 * 22;
    expect(volume(ev, d)).toBeCloseTo(outer - 20 * 20 * 20, 6);
    expect(withRole(ev, d, 'inner')).toHaveLength(5);
    expect(withRole(ev, d, 'rim')).toHaveLength(1);
    expect(centroid(ev, follow(p.side, ev, d).key)[0]).toBeCloseTo(20, 6);
  });

  it('shells a hole-drilled block and keeps the bore named', () => {
    const p = picks();
    const d = new DocBuilder();
    box(d);
    const id = d.id('hp');
    adopt(d, p.ev);
    hole(d, { placement: frameAt(d, 20), positions: [{ id, at: point(d, 10, 10) }], depth: '5 mm', tip: '120 deg' });
    shell(d, [{ entity: p.body }], [{ entity: p.side }], '1 mm');
    const ev = build(d);
    expect(at(ev, d, 'bore', id)).toHaveLength(1);
    expect(withRole(ev, d, 'rim')).toHaveLength(1);
  });

  it('shells a round body', () => {
    const d0 = new DocBuilder();
    const round = (d: DocBuilder) => {
      const s = d.sketch('xy', (x) => x.circle(0, 0, 10));
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '20 mm' }] });
    };
    round(d0);
    const ev0 = build(d0);
    const records = {
      top: pick(ev0, d0, withRole(ev0, d0, 'end')[0] as NamedEntity),
      body: pick(ev0, d0, body(ev0, d0)),
    };
    const d = new DocBuilder();
    round(d);
    adopt(d, ev0);
    shell(d, [{ entity: records.body }], [{ entity: records.top }], '2 mm');
    const ev = build(d);
    expect(volume(ev, d)).toBeCloseTo(circleArea(10) * 20 - circleArea(8) * 18, 4);
    expect(withRole(ev, d, 'inner')).toHaveLength(2);
    expect(withRole(ev, d, 'rim')).toHaveLength(1);
  });

  it('opens a drilled top: one rim per opening, apart by their neighbours', () => {
    const p = picks();
    const d = new DocBuilder();
    box(d);
    adopt(d, p.ev);
    hole(d, { placement: frameAt(d, 20), positions: [{ id: HP1, at: point(d, 10, 10) }], diameter: '4 mm' });
    shell(d, [{ entity: p.body }], [{ entity: p.top }], '2 mm');
    const ev = build(d);
    const rims = withRole(ev, d, 'rim');
    expect(rims.map((e) => area(ev, e.key)).sort((x, y) => x - y)).toEqual([
      expect.closeTo(circleArea(4) - circleArea(2), 6),
      expect.closeTo(400 - 256, 6),
    ]);
    expect(finest(rims[0]!.ladder)).toEqual(finest(rims[1]!.ladder));
    for (const rim of rims) expect(follow(pick(ev, d, rim), ev, d).key).toBe(rim.key);
    expect(faces(ev, d).filter((e) => e.ladder.length < 2)).toEqual([]);
  });

  it('gives the inner walls of two face pieces the branch of each', () => {
    const grooved = (d: DocBuilder) => {
      box(d, 20, 40);
      const groove = d.sketch('xy', (x) => x.rect(18, -1, 4, 22), 20);
      d.extrude({
        sketch: groove.feature,
        profiles: [groove.region([20, 5])],
        sides: [{ distance: '3 mm' }],
        reversed: true,
        op: 'cut',
      });
    };
    const d0 = new DocBuilder();
    grooved(d0);
    const ev0 = build(d0);
    const bottom = pick(ev0, d0, withRole(ev0, d0, 'start')[0] as NamedEntity);
    const whole = pick(ev0, d0, body(ev0, d0));
    const d = new DocBuilder();
    grooved(d);
    adopt(d, ev0);
    shell(d, [{ entity: whole }], [{ entity: bottom }], '2 mm');
    const ev = build(d);
    const tops = withRole(ev, d, 'inner').filter((e) => Math.abs(centroid(ev, e.key)[2] - 18) < 1e-6);
    expect(tops).toHaveLength(2);
    expect(tops[0]?.branch).not.toEqual(tops[1]?.branch);
    expect(tops[0]?.branch).toHaveLength(1);
    const left = tops.find((e) => centroid(ev, e.key)[0] < 18) as NamedEntity;
    expect(centroid(ev, follow(pick(ev, d, left), ev, d).key)[0]).toBeLessThan(18);
  });

  it('pauses when a removed face is gone', () => {
    const base = (d: DocBuilder, on: boolean) => {
      box(d);
      const s = d.sketch('xy', (x) => x.rect(5, 5, 10, 10), 20);
      if (on) d.extrude({ sketch: s.feature, profiles: [s.region([6, 6])], sides: [{ distance: '3 mm' }], op: 'join' });
    };
    const d0 = new DocBuilder();
    base(d0, true);
    const ev0 = build(d0);
    const top = faces(ev0, d0).find((e) => Math.abs(centroid(ev0, e.key)[2] - 23) < 1e-6) as NamedEntity;
    const records = { top: pick(ev0, d0, top), body: pick(ev0, d0, body(ev0, d0)) };
    const d = new DocBuilder();
    base(d, false);
    adopt(d, ev0);
    shell(d, [{ entity: records.body }], [{ entity: records.top }], '2 mm');
    expect(evaluate(d).pauses.map((p) => p.message)).toEqual(['a removed face is gone']);
  });

  it('pauses when a removed face has become two pieces', () => {
    const p = picks(20, 40);
    const d = new DocBuilder();
    box(d, 20, 40);
    adopt(d, p.ev);
    const groove = d.sketch('xy', (x) => x.rect(18, -1, 4, 22), 20);
    d.extrude({
      sketch: groove.feature,
      profiles: [groove.region([20, 5])],
      sides: [{ distance: '3 mm' }],
      reversed: true,
      op: 'cut',
    });
    shell(d, [{ entity: p.body }], [{ entity: p.top }], '2 mm');
    expect(evaluate(d).pauses.map((x) => x.message)).toEqual(['a removed face is ambiguous']);
  });

  it('pauses rather than return a body it did not hollow, and for what is not built', () => {
    const messages = (thickness: string, direction = 'inside') =>
      evaluate(shelled(thickness, 20, 20, direction).d).pauses.map((p) => p.message);
    expect(messages('10 mm')).toEqual(['the shell is too thick for this body']);
    expect(messages('15 mm')).toEqual(['the kernel cannot shell this body at this thickness']);
    expect(messages('2 mm', 'both')).toEqual(['a shell on both sides needs an outside thickness']);
    expect(messages('0 mm')).toEqual(['the shell has no thickness']);

    const p = picks();
    const d = new DocBuilder();
    box(d);
    adopt(d, p.ev);
    shell(d, [{ entity: p.body }], [{ entity: p.top }], '2 mm', 'both', '0 mm');
    expect(evaluate(d).pauses.map((x) => x.message)).toEqual(['the shell has no outside thickness']);

    const solid = new DocBuilder();
    box(solid);
    adopt(solid, p.ev);
    shell(solid, [{ entity: p.body }], [], '10 mm');
    expect(evaluate(solid).pauses.map((x) => x.message)).toEqual(['the shell is too thick for this body']);
  });

  describe('on both sides', () => {
    const both = (inside: string, outside: string, height = 20) => {
      const p = picks();
      const d = new DocBuilder();
      box(d, height);
      adopt(d, p.ev);
      shell(d, [{ entity: p.body }], [{ entity: p.top }], inside, 'both', outside);
      return { d, p };
    };

    it('walls a box from the inside thickness in to the outside thickness out, open at the top, the outer skin under the original names', () => {
      const { d, p } = both('2 mm', '3 mm');
      const ev = build(d);
      expect(volume(ev, d)).toBeCloseTo(26 * 26 * 23 - 16 * 16 * 18, 6);
      expect(withRole(ev, d, 'inner')).toHaveLength(5);
      expect(withRole(ev, d, 'outer')).toHaveLength(0);
      expect(centroid(ev, follow(p.side, ev, d).key)[0]).toBeCloseTo(23, 6);
      const rim = withRole(ev, d, 'rim');
      expect(rim).toHaveLength(1);
      expect(area(ev, rim[0]!.key)).toBeCloseTo(26 * 26 - 16 * 16, 6);
      expect(centroid(ev, rim[0]!.key)[2]).toBeCloseTo(20, 6);
      expect(faces(ev, d)).toHaveLength(11);
    });

    it('keeps picks on an outer wall, an inner wall and the rim through new thicknesses and a taller box', () => {
      const { d, p } = both('2 mm', '3 mm');
      const ev = build(d);
      const outer = faces(ev, d).find((e) => Math.abs(centroid(ev, e.key)[0] - 23) < 1e-6) as NamedEntity;
      const inner = withRole(ev, d, 'inner').find((e) => Math.abs(centroid(ev, e.key)[0] - 18) < 1e-6) as NamedEntity;
      const records = {
        outer: pick(ev, d, outer),
        inner: pick(ev, d, inner),
        rim: pick(ev, d, withRole(ev, d, 'rim')[0] as NamedEntity),
      };

      const thicker = both('1 mm', '4 mm', 30).d;
      const ev2 = build(thicker);
      expect(centroid(ev2, follow(records.outer, ev2, thicker).key)[0]).toBeCloseTo(24, 6);
      expect(centroid(ev2, follow(p.side, ev2, thicker).key)[0]).toBeCloseTo(24, 6);
      expect(centroid(ev2, follow(records.inner, ev2, thicker).key)[0]).toBeCloseTo(19, 6);
      const rim = follow(records.rim, ev2, thicker);
      expect(centroid(ev2, rim.key)[2]).toBeCloseTo(30, 6);
      expect(area(ev2, rim.key)).toBeCloseTo(28 * 28 - 18 * 18, 6);
    });
  });

  describe('a closed body', () => {
    const closedShell = (thickness: string, direction = 'inside', outside?: string, height = 20) => {
      const p = picks();
      const d = new DocBuilder();
      box(d, height);
      adopt(d, p.ev);
      shell(d, [{ entity: p.body }], [], thickness, direction, outside);
      return { d, p };
    };

    it('hollows a box around a sealed void, the outer faces named as they were', () => {
      const { d, p } = closedShell('2 mm');
      const ev = build(d);
      expect(volume(ev, d)).toBeCloseTo(20 * 20 * 20 - 16 * 16 * 16, 6);
      expect(all(ev, d).filter((e) => e.kind === 'body')).toHaveLength(1);
      expect(follow(p.body, ev, d).key).toBe(body(ev, d).key);
      const voids = withRole(ev, d, 'inner');
      expect(voids).toHaveLength(6);
      expect(faces(ev, d)).toHaveLength(12);
      const side = follow(p.side, ev, d);
      expect(centroid(ev, side.key)[0]).toBeCloseTo(20, 6);
      // Each face of the void is named after the outer face it offsets.
      const facing = voids.filter(
        (e) => JSON.stringify(nameOf(ev, e).src) === JSON.stringify([{ name: { hash: finest(side.ladder) } }]),
      );
      expect(facing).toHaveLength(1);
      expect(centroid(ev, facing[0]!.key)[0]).toBeCloseTo(18, 6);
    });

    it('keeps a pick on a face of the void through a new thickness and a taller box', () => {
      const { d } = closedShell('2 mm');
      const ev = build(d);
      const wall = withRole(ev, d, 'inner').find((e) => Math.abs(centroid(ev, e.key)[0] - 18) < 1e-6) as NamedEntity;
      const roof = withRole(ev, d, 'inner').find((e) => Math.abs(centroid(ev, e.key)[2] - 18) < 1e-6) as NamedEntity;
      const records = { wall: pick(ev, d, wall), roof: pick(ev, d, roof) };

      const thicker = closedShell('3 mm').d;
      const ev2 = build(thicker);
      expect(centroid(ev2, follow(records.wall, ev2, thicker).key)[0]).toBeCloseTo(17, 6);
      expect(centroid(ev2, follow(records.roof, ev2, thicker).key)[2]).toBeCloseTo(17, 6);

      const taller = closedShell('2 mm', 'inside', undefined, 30).d;
      const ev3 = build(taller);
      expect(centroid(ev3, follow(records.wall, ev3, taller).key)[0]).toBeCloseTo(18, 6);
      expect(centroid(ev3, follow(records.roof, ev3, taller).key)[2]).toBeCloseTo(28, 6);
    });

    it('grows outward around the body, which becomes the void', () => {
      const { d, p } = closedShell('2 mm', 'outside');
      const ev = build(d);
      expect(volume(ev, d)).toBeCloseTo(24 * 24 * 24 - 20 * 20 * 20, 6);
      expect(withRole(ev, d, 'inner')).toHaveLength(6);
      expect(centroid(ev, follow(p.side, ev, d).key)[0]).toBeCloseTo(20, 6);
    });

    it('walls both ways, the void inner after the faces it offsets and the outer skin under the original names', () => {
      const { d, p } = closedShell('2 mm', 'both', '3 mm');
      const ev = build(d);
      expect(volume(ev, d)).toBeCloseTo(26 * 26 * 26 - 16 * 16 * 16, 6);
      expect(withRole(ev, d, 'inner')).toHaveLength(6);
      expect(withRole(ev, d, 'outer')).toHaveLength(0);
      expect(centroid(ev, follow(p.side, ev, d).key)[0]).toBeCloseTo(23, 6);
      expect(follow(p.body, ev, d).key).toBe(body(ev, d).key);
      expect(faces(ev, d)).toHaveLength(12);
    });

    it('hollows a round body', () => {
      const d0 = new DocBuilder();
      const round = (d: DocBuilder) => {
        const s = d.sketch('xy', (x) => x.circle(0, 0, 10));
        d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '20 mm' }] });
      };
      round(d0);
      const ev0 = build(d0);
      const d = new DocBuilder();
      round(d);
      adopt(d, ev0);
      shell(d, [{ entity: pick(ev0, d0, body(ev0, d0)) }], [], '2 mm');
      const ev = build(d);
      expect(volume(ev, d)).toBeCloseTo(circleArea(10) * 20 - circleArea(8) * 16, 4);
      expect(withRole(ev, d, 'inner')).toHaveLength(3);
    });
  });
});
