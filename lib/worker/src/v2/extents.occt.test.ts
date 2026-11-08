/**
 * Extrude stops, tapers, thin walls and revolve axes on the real kernel:
 * extrudes up to a face, a body, the next or the last face; two sides with
 * their own tapers; thin extrudes and revolves; a revolve about a model edge.
 * Picks made before an edit resolve after it to the face that is
 * geometrically the same, and the cases that should pause do.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  makeSet,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type ShapeKey,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder, type SketchDraw } from './docBuilder';
import { constructionRef } from './primitivesDocs';
import { evaluateDocument, type Evaluation } from './evaluate';
import { entityPrints, preciseBuild } from './boundsOracle';
import type { Json } from './context';

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

function evaluate(d: DocBuilder): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k, { solver: gcs });
  builds.push(ev);
  // The reach of an extrude taken from loose boxes builds what precise boxes build.
  const precise = preciseBuild(doc, k, { solver: gcs });
  builds.push(precise);
  expect(entityPrints(ev)).toEqual(entityPrints(precise));
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = evaluate(d);
  expect(ev.pauses).toEqual([]);
  return ev;
}

/** The one pause a document ends on. */
function pauseOf(d: DocBuilder): string {
  const { pauses } = evaluate(d);
  expect(pauses).toHaveLength(1);
  return (pauses[0] as { message: string }).message;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const all = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const totalVolume = (ev: Evaluation, d: DocBuilder) => bodies(ev, d).reduce((s, b) => s + volume(ev, b), 0);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const facesOf = (ev: Evaluation, d: DocBuilder, role: string) =>
  all(ev, d).filter((e) => e.kind === 'face' && roleOf(ev, e) === role);
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, stateOf(ev, d), ev.adapter);
const identity = (e: NamedEntity) => JSON.stringify([e.ladder, e.branch]);

/** The one entity a pick resolves to. */
function found(ev: Evaluation, d: DocBuilder, record: EntityRecord): ShapeKey {
  const result = resolve(record, stateOf(ev, d), ev.adapter);
  expect(result.outcome).toBe('same');
  expect(result.outcome === 'same' ? result.entities : []).toHaveLength(1);
  return result.outcome === 'same' ? (result.entities[0]?.key as ShapeKey) : -1;
}

/** The face of the build whose centroid is `at`. */
function faceAt(ev: Evaluation, d: DocBuilder, at: Vec3): NamedEntity {
  const hits = all(ev, d).filter((e) => {
    if (e.kind !== 'face') return false;
    const c = centroid(ev, e.key);
    return Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) < 1e-6;
  });
  expect(hits).toHaveLength(1);
  return hits[0] as NamedEntity;
}

const val = (d: DocBuilder, text: string) => d.val(text);
const side = (d: DocBuilder, extent: Json, taper = '0 deg') => ({ extent, taper: val(d, taper) });
const distance = (d: DocBuilder, s: string) => ({ distance: { d: val(d, s) } });
const toFace = (d: DocBuilder, face: Json, offset = '0 mm') => ({ toFace: { face, offset: val(d, offset) } });
const thinWall = (d: DocBuilder, thickness: string, placement: 'inside' | 'outside' | 'center') => ({
  thin: { thickness: val(d, thickness), placement: val(d, `"${placement}"`) },
});

interface Extrude {
  sketch: string;
  profiles: Json[];
  sides: Json[];
  thin?: Json;
  op?: 'new' | 'join' | 'cut' | 'intersect';
  /** Against the sketch normal. */
  reversed?: boolean;
}

function extrude(d: DocBuilder, o: Extrude): string {
  return d.feature('core.extrude', {
    profiles: makeSet(o.profiles),
    sides: o.sides,
    direction: {
      normal: { ref: { object: { feature: { id: o.sketch } } }, reversed: val(d, o.reversed ? 'true' : 'false') },
    },
    thin: o.thin ?? { solid: {} },
    operation: { op: val(d, `"${o.op ?? 'new'}"`), targets: { all: {} }, keepTools: val(d, 'false') },
  });
}

/** A closed polygon of sketch points. */
function polygon(x: SketchDraw, points: readonly (readonly [number, number])[]): void {
  const ids = points.map((p) => x.point(p[0], p[1]));
  ids.forEach((p, i) => x.line(p, ids[(i + 1) % ids.length] as string));
}

/** Copies the names of a build into a document, so its picks read there. */
function withNames(d: DocBuilder, ev: Evaluation): DocBuilder {
  for (const name of Object.values(ev.names.toJson() as Json)) d.names.intern(name as never);
  return d;
}

/**
 * A 20 × 10 × 5 plate, with whatever `roof` adds above it, and optionally a
 * 4 × 4 post from the plate's top up to `end`.
 */
function scene(roof: (d: DocBuilder) => void, post?: (d: DocBuilder) => Json[], op: Extrude['op'] = 'new'): DocBuilder {
  const d = new DocBuilder();
  const plate = d.sketch('xy', (x) => x.rect(0, 0, 20, 10));
  extrude(d, { sketch: plate.feature, profiles: [plate.region([1, 1])], sides: [side(d, distance(d, '5 mm'))] });
  roof(d);
  if (post) {
    const s = d.sketch('xy', (x) => x.rect(8, 3, 4, 4), 5);
    extrude(d, { sketch: s.feature, profiles: [s.region([9, 4])], sides: post(d), op });
  }
  return d;
}

/** A block from `x0` to `x1`, full depth, between heights `z0` and `z1`. */
const block = (x0: number, x1: number, z0: number, z1: number) => (d: DocBuilder) => {
  const s = d.sketch('xy', (x) => x.rect(x0, -2, x1 - x0, 14), z0);
  extrude(d, {
    sketch: s.feature,
    profiles: [s.region([x0 + 0.5, 1])],
    sides: [side(d, distance(d, `${z1 - z0} mm`))],
  });
};

/** The post of the last build, the body made last. */
const postOf = (ev: Evaluation, d: DocBuilder) =>
  bodies(ev, d).sort((a, b) => b.createdAt - a.createdAt)[0] as NamedEntity;

/** Picks the face at `at` in `roof`'s scene before the post exists. */
function pickInScene(roof: (d: DocBuilder) => void, at: Vec3): { ev: Evaluation; record: EntityRecord } {
  const d = scene(roof);
  const ev = build(d);
  return { ev, record: pick(ev, d, faceAt(ev, d, at)) };
}

describe('extrude up to a face', () => {
  it('ends on a face above, its end cap on that face, and the cap and walls survive the face moving', () => {
    const roof = (z: number) => block(0, 20, z, z + 5);
    const base = pickInScene(roof(20), [10, 5, 20]);
    const posted = (z: number) =>
      withNames(
        scene(roof(z), (d) => [side(d, toFace(d, { entity: base.record }))]),
        base.ev,
      );

    const d1 = posted(20);
    const before = build(d1);
    expect(volume(before, postOf(before, d1))).toBeCloseTo(4 * 4 * 15, 6);
    const end = facesOf(before, d1, 'end').filter((e) => e.createdBy === postOf(before, d1).createdBy);
    expect(end).toHaveLength(1);
    expect(centroid(before, (end[0] as NamedEntity).key)[2]).toBeCloseTo(20, 9);
    const capPick = pick(before, d1, end[0] as NamedEntity);
    const wallPick = pick(before, d1, faceAt(before, d1, [12, 5, 12.5]));

    const d2 = posted(26);
    const after = build(d2);
    expect(volume(after, postOf(after, d2))).toBeCloseTo(4 * 4 * 21, 6);
    expect(centroid(after, found(after, d2, capPick))[2]).toBeCloseTo(26, 9);
    const wall = centroid(after, found(after, d2, wallPick));
    expect(wall[0]).toBeCloseTo(12, 9);
    expect(wall[2]).toBeCloseTo(15.5, 9);
  });

  it('extends a plane the profile does not wholly reach, and moves the stop by the offset', () => {
    const roof = block(0, 10, 20, 25);
    const base = pickInScene(roof, [5, 5, 20]);
    const d = withNames(
      scene(roof, (x) => [side(x, toFace(x, { entity: base.record }))]),
      base.ev,
    );
    const ev = build(d);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(4 * 4 * 15, 6);

    const short = withNames(
      scene(roof, (x) => [side(x, toFace(x, { entity: base.record }, '-2 mm'))]),
      base.ev,
    );
    const ev2 = build(short);
    expect(volume(ev2, postOf(ev2, short))).toBeCloseTo(4 * 4 * 13, 6);
  });

  it('ends on a slanted face, the cap taking its slope', () => {
    // A wedge whose underside rises from z = 20 at x = 0 by half a unit per unit, from y = 0 to 12.
    // On the XZ plane sketch y is world −Z and the normal is +Y.
    const wedge = (d: DocBuilder) => {
      const s = d.sketch('xz', (x) =>
        polygon(x, [
          [0, -20],
          [30, -35],
          [30, -40],
          [0, -40],
        ]),
      );
      extrude(d, { sketch: s.feature, profiles: [s.region([10, -35])], sides: [side(d, distance(d, '12 mm'))] });
    };
    const base = pickInScene(wedge, [15, 6, 27.5]);
    const d = withNames(
      scene(wedge, (x) => [side(x, toFace(x, { entity: base.record }))]),
      base.ev,
    );
    const ev = build(d);
    // Heights 20 + x / 2 - 5 over x from 8 to 12, 4 deep.
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(4 * (15 * 4 + 0.25 * (144 - 64)), 6);
    const end = facesOf(ev, d, 'end').filter((e) => e.createdBy === postOf(ev, d).createdBy);
    expect(end).toHaveLength(1);
    expect(centroid(ev, (end[0] as NamedEntity).key)[2]).toBeCloseTo(25, 6);
  });

  it('ends on a curved face, and keeps the cap on it when the cylinder rises', () => {
    // A rod along y from `y0`, radius 8, its axis at x = 10 and height `z`.
    const rod =
      (z: number, y0 = -2, length = 14) =>
      (d: DocBuilder) => {
        const s = d.sketch('xz', (x) => x.circle(10, -z, 8), y0);
        extrude(d, {
          sketch: s.feature,
          profiles: [s.region([10, -z])],
          sides: [side(d, distance(d, `${length} mm`))],
        });
      };
    const underside = (z: number): Vec3 => [10, 5, z];
    const base = pickInScene(rod(30), underside(30));
    const posted = (z: number, more: Partial<{ y0: number; length: number }> = {}) =>
      withNames(
        scene(rod(z, more.y0, more.length), (x) => [side(x, toFace(x, { entity: base.record }))]),
        base.ev,
      );
    // Heights 30 - sqrt(64 - (x - 10)²) - 5 over x from 8 to 12, 4 deep.
    const expected = (z: number) => {
      let s = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const x = 8 + ((i + 0.5) * 4) / n;
        s += (z - Math.sqrt(64 - (x - 10) ** 2) - 5) * (4 / n);
      }
      return 4 * s;
    };
    const d1 = posted(30);
    const before = build(d1);
    expect(volume(before, postOf(before, d1))).toBeCloseTo(expected(30), 3);
    const end = facesOf(before, d1, 'end').filter((e) => e.createdBy === postOf(before, d1).createdBy) as NamedEntity[];
    expect(end).toHaveLength(1);
    expect(before.adapter.faceGeometry((end[0] as NamedEntity).key).surface.kind).toBe('cylinder');
    const capPick = pick(before, d1, end[0] as NamedEntity);

    const d2 = posted(34);
    const after = build(d2);
    expect(volume(after, postOf(after, d2))).toBeCloseTo(expected(34), 3);
    const cap = found(after, d2, capPick);
    expect(after.adapter.faceGeometry(cap).surface.kind).toBe('cylinder');
    expect(centroid(after, cap)[2]).toBeLessThan(34 - 7);

    // A rod too short to cover the post is extended along its axis.
    const d3 = posted(30, { y0: -2, length: 6 });
    const ev3 = build(d3);
    expect(volume(ev3, postOf(ev3, d3))).toBeCloseTo(expected(30), 3);
  });

  it('stops at a default plane', () => {
    // Up to the XZ default plane from a sketch facing it: a 4 × 4 bar from y = −8 up to y = 0.
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => x.rect(0, 0, 4, 4), -8);
    extrude(d, {
      sketch: s.feature,
      profiles: [s.region([1, 1])],
      sides: [side(d, toFace(d, { standard: { name: 'xz' } }))],
    });
    const ev = build(d);
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(4 * 4 * 8, 6);
    expect(centroid(ev, (facesOf(ev, d, 'end')[0] as NamedEntity).key)[1]).toBeCloseTo(0, 9);
  });

  it('stops at a construction plane far from the profile', () => {
    const d = new DocBuilder();
    const placement = val(d, 'placement(vector(0 mm, 0 mm, 1000 mm), rotate(vector(0, 0, 1), 0 deg))');
    const plane = d.feature('core.constructionPlane', { frame: { fixed: { placement } } });
    const s = d.sketch('xy', (x) => x.rect(0, 0, 4, 4));
    extrude(d, {
      sketch: s.feature,
      profiles: [s.region([1, 1])],
      sides: [side(d, toFace(d, constructionRef(d, plane, 'plane')))],
    });
    const ev = build(d);
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(4 * 4 * 1000, 4);
    expect(centroid(ev, (facesOf(ev, d, 'end')[0] as NamedEntity).key)[2]).toBeCloseTo(1000, 9);
  });

  it('ends the second side on a face, its start cap there', () => {
    const base = pickInScene(() => undefined, [10, 5, 0]);
    const d = withNames(
      scene(
        () => undefined,
        (x) => [side(x, distance(x, '3 mm')), side(x, toFace(x, { entity: base.record }))],
      ),
      base.ev,
    );
    const ev = build(d);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(4 * 4 * 8, 6);
    const start = facesOf(ev, d, 'start').filter((e) => e.createdBy === postOf(ev, d).createdBy);
    expect(start).toHaveLength(1);
    expect(centroid(ev, (start[0] as NamedEntity).key)[2]).toBeCloseTo(0, 9);
  });

  it('pauses a face behind the profile, one that meets it, and a curved face it cannot extend', () => {
    const base = pickInScene(block(0, 20, 20, 25), [10, 5, 25]);
    // The roof's top seen from below the roof: the stop is past the roof's own bottom, but reachable.
    const through = withNames(
      scene(block(0, 20, 20, 25), (x) => [side(x, toFace(x, { entity: base.record }))]),
      base.ev,
    );
    expect(volume(build(through), postOf(build(through), through))).toBeCloseTo(4 * 4 * 20, 6);

    const floor = pickInScene(() => undefined, [10, 5, 0]);
    const behind = withNames(
      scene(
        () => undefined,
        (x) => [side(x, toFace(x, { entity: floor.record }))],
      ),
      floor.ev,
    );
    expect(pauseOf(behind)).toBe('the extrude does not reach the target face');

    const top = pickInScene(() => undefined, [10, 5, 5]);
    const meets = withNames(
      scene(
        () => undefined,
        (x) => [side(x, toFace(x, { entity: top.record }))],
      ),
      top.ev,
    );
    expect(pauseOf(meets)).toBe('the extrude stops at something that meets the profile');

    // A cone, turned from a triangle, that covers only part of the post.
    const cone = (d: DocBuilder) => {
      const s = d.sketch('xz', (x) =>
        polygon(x, [
          [0, -20],
          [9, -20],
          [0, -30],
        ]),
      );
      d.feature('core.revolve', {
        profiles: makeSet([s.region([1, -21])]),
        axis: { along: { ref: { standard: { name: 'z' } }, reversed: val(d, 'false') } },
        sides: [{ angle: { a: val(d, '300 deg') } }],
        thin: { solid: {} },
        operation: { op: val(d, '"new"'), targets: { all: {} }, keepTools: val(d, 'false') },
      });
    };
    const ev = build(scene(cone));
    const slope = all(ev, scene(cone)).find(
      (e) => e.kind === 'face' && ev.adapter.faceGeometry(e.key).surface.kind === 'cone',
    ) as NamedEntity;
    const coneBase = { ev, record: pick(ev, scene(cone), slope) };
    const past = withNames(
      scene(cone, (x) => [side(x, toFace(x, { entity: coneBase.record }))]),
      coneBase.ev,
    );
    expect(pauseOf(past)).toBe('the profile runs past the curved target face, which is not extended yet');
  });
});

describe('extrude up to a body, the next face and the last', () => {
  const two = (d: DocBuilder) => {
    block(0, 20, 20, 25)(d);
    block(0, 20, 40, 45)(d);
  };

  it('stops at the body it meets first', () => {
    const d0 = scene(two);
    const ev0 = build(d0);
    const lower = bodies(ev0, d0).find(
      (b) => Math.abs((ev0.adapter.measures(b.key).bbox as Vec3[])[0]![2] - 20) < 1e-9,
    ) as NamedEntity;
    const record = pick(ev0, d0, lower);
    const d = withNames(
      scene(two, (x) => [side(x, { toBody: { body: { entity: record } } })]),
      ev0,
    );
    const ev = build(d);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(4 * 4 * 15, 6);

    const upper = bodies(ev0, d0).find(
      (b) => Math.abs((ev0.adapter.measures(b.key).bbox as Vec3[])[0]![2] - 40) < 1e-9,
    ) as NamedEntity;
    const d2 = withNames(
      scene(two, (x) => [side(x, { toBody: { body: { entity: pick(ev0, d0, upper) } } })]),
      ev0,
    );
    const ev2 = build(d2);
    // The upper roof is behind the lower one, so the post passes the lower roof's inside on the way.
    expect(volume(ev2, postOf(ev2, d2))).toBeCloseTo(4 * 4 * 35, 6);
  });

  it('stops at the next face and at the last face on the ray from the profile', () => {
    const next = scene(two, (x) => [side(x, { upToNext: {} })]);
    const ev = build(next);
    expect(volume(ev, postOf(ev, next))).toBeCloseTo(4 * 4 * 15, 6);
    const last = scene(two, (x) => [side(x, { upToLast: {} })]);
    const ev2 = build(last);
    expect(volume(ev2, postOf(ev2, last))).toBeCloseTo(4 * 4 * 40, 6);
  });

  it('keeps a pick on the up-to-next cap when the roof rises', () => {
    const roofed = (z: number) => scene(block(0, 20, z, z + 5), (x) => [side(x, { upToNext: {} })], 'join');
    const d1 = roofed(20);
    const before = build(d1);
    // Joined, the post's walls meet the plate and the roof; the cap is gone inside the joined body.
    expect(bodies(before, d1)).toHaveLength(1);
    const wallPick = pick(before, d1, faceAt(before, d1, [12, 5, 12.5]));
    const after = build(roofed(24));
    const wall = centroid(after, found(after, roofed(24), wallPick));
    expect(wall[2]).toBeCloseTo(14.5, 9);
  });

  it('pauses when no face lies ahead, when the body does not cover the profile, and when it holds the profile', () => {
    expect(
      pauseOf(
        scene(
          () => undefined,
          (x) => [side(x, { upToNext: {} })],
        ),
      ),
    ).toBe('no face of the target bodies lies ahead of the profile');
    const narrow = block(0, 9, 20, 25);
    const d0 = scene(narrow);
    const ev0 = build(d0);
    const roofBody = bodies(ev0, d0).find(
      (b) => Math.abs((ev0.adapter.measures(b.key).bbox as Vec3[])[0]![2] - 20) < 1e-9,
    ) as NamedEntity;
    const d = withNames(
      scene(narrow, (x) => [side(x, { toBody: { body: { entity: pick(ev0, d0, roofBody) } } })]),
      ev0,
    );
    expect(pauseOf(d)).toBe('the profile runs past the target body');

    // A body round the profile.
    const around = block(0, 20, 2, 25);
    const e0 = build(scene(around));
    const box = bodies(e0, scene(around)).find(
      (b) => Math.abs((e0.adapter.measures(b.key).bbox as Vec3[])[0]![2] - 2) < 1e-9,
    ) as NamedEntity;
    const inside = withNames(
      scene(around, (x) => [side(x, { toBody: { body: { entity: pick(e0, scene(around), box) } } })]),
      e0,
    );
    expect(pauseOf(inside)).toBe('the extrude stops at something that meets the profile');
  });
});

describe('tapers', () => {
  /** A 20 × 10 rectangle on the XY plane at height `z`, extruded by `sides`. */
  const tapered = (sides: (d: DocBuilder) => Json[], z = 0) => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 10), z);
    extrude(d, { sketch: s.feature, profiles: [s.region([1, 1])], sides: sides(d) });
    return d;
  };
  /** The volume of the rectangle swept `h` with its sides moving out by tan(degrees) per unit. */
  const frustum = (h: number, degrees: number) => {
    const t = Math.tan((degrees * Math.PI) / 180);
    return 200 * h + 30 * t * h * h + (4 / 3) * t * t * h * h * h;
  };

  it('tapers each side by its own angle from the sketch plane, positive widening', () => {
    const d = tapered((x) => [side(x, distance(x, '10 mm'), '5 deg'), side(x, distance(x, '4 mm'), '10 deg')]);
    const ev = build(d);
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(frustum(10, 5) + frustum(4, 10), 6);
    const walls = facesOf(ev, d, 'side');
    expect(walls).toHaveLength(8);
    expect(new Set(walls.map(identity)).size).toBe(8);
    expect(facesOf(ev, d, 'start')).toHaveLength(1);
    expect(facesOf(ev, d, 'end')).toHaveLength(1);
    expect(centroid(ev, (facesOf(ev, d, 'start')[0] as NamedEntity).key)[2]).toBeCloseTo(-4, 9);
  });

  it('runs one wall straight through the sketch plane when the second taper is the opposite of the first', () => {
    const d = tapered((x) => [side(x, distance(x, '10 mm'), '5 deg'), side(x, distance(x, '4 mm'), '-5 deg')]);
    const ev = build(d);
    // The section grows from the back end to the front at one slope, the sketch section 4 mm along.
    const t = Math.tan((5 * Math.PI) / 180);
    const at = (h: number) => (20 + 2 * h * t) * (10 + 2 * h * t);
    let expected = 0;
    for (let i = 0; i < 10000; i++) expected += at(-4 + ((i + 0.5) * 14) / 10000) * (14 / 10000);
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(expected, 3);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
  });

  it('tapers both halves of a symmetric extent alike, and pivots about a sketch plane off the origin', () => {
    const sym = tapered((x) => [
      { extent: { symmetric: { d: val(x, '8 mm'), measure: val(x, '"total"') } }, taper: val(x, '5 deg') },
    ]);
    const ev = build(sym);
    expect(volume(ev, bodies(ev, sym)[0] as NamedEntity)).toBeCloseTo(2 * frustum(4, 5), 6);
    expect(facesOf(ev, sym, 'side')).toHaveLength(8);

    const raised = tapered((x) => [side(x, distance(x, '10 mm'), '5 deg')], 7);
    const ev2 = build(raised);
    expect(volume(ev2, bodies(ev2, raised)[0] as NamedEntity)).toBeCloseTo(frustum(10, 5), 6);
  });

  it('keeps picks on the walls of each side when either taper changes', () => {
    const d = (a: string, b: string) =>
      tapered((x) => [side(x, distance(x, '10 mm'), a), side(x, distance(x, '4 mm'), b)]);
    const d1 = d('5 deg', '10 deg');
    const before = build(d1);
    // The +x walls: the first side's above the sketch plane, the second's below it.
    const plusX = (ev: Evaluation, dd: DocBuilder, up: boolean) =>
      facesOf(ev, dd, 'side').find((e) => {
        const c = centroid(ev, e.key);
        return c[0] > 19 && (up ? c[2] > 0 : c[2] < 0);
      }) as NamedEntity;
    const upper = pick(before, d1, plusX(before, d1, true));
    const lower = pick(before, d1, plusX(before, d1, false));
    for (const [a, b] of [
      ['8 deg', '10 deg'],
      ['5 deg', '2 deg'],
    ] as const) {
      const d2 = d(a, b);
      const after = build(d2);
      expect(found(after, d2, upper)).toBe(plusX(after, d2, true).key);
      expect(found(after, d2, lower)).toBe(plusX(after, d2, false).key);
    }
  });

  it('tapers up to a face', () => {
    const base = pickInScene(block(0, 20, 20, 25), [10, 5, 20]);
    const d = withNames(
      scene(block(0, 20, 20, 25), (x) => [side(x, toFace(x, { entity: base.record }), '5 deg')]),
      base.ev,
    );
    const ev = build(d);
    const t = Math.tan((5 * Math.PI) / 180);
    const h = 15;
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(16 * h + 8 * t * h * h + (4 / 3) * t * t * h ** 3, 6);
  });

  it('pauses a taper with a negative second side', () => {
    const d = tapered((x) => [side(x, distance(x, '10 mm'), '5 deg'), side(x, distance(x, '-3 mm'))]);
    expect(pauseOf(d)).toBe('a tapered extrude with a negative second side is not built yet');
  });
});

describe('thin extrudes', () => {
  const thinPlate = (
    thickness: string,
    placement: 'inside' | 'outside' | 'center',
    draw: (x: SketchDraw) => void = (x) => x.rect(0, 0, 20, 10),
    inside: readonly [number, number] = [0.5, 0.5],
  ) => {
    const d = new DocBuilder();
    const s = d.sketch('xy', draw);
    extrude(d, {
      sketch: s.feature,
      profiles: [s.region(inside)],
      sides: [side(d, distance(d, '5 mm'))],
      thin: thinWall(d, thickness, placement),
    });
    return d;
  };

  it('puts the wall inside, outside or centred on the profile, naming each face by where it lies', () => {
    const cases = [
      ['inside', (200 - 18 * 8) * 5, { side: 4, inner: 4, outer: 0 }],
      ['outside', (22 * 12 - 200) * 5, { side: 4, inner: 0, outer: 4 }],
      ['center', (21 * 11 - 19 * 9) * 5, { side: 0, inner: 4, outer: 4 }],
    ] as const;
    for (const [placement, expected, counts] of cases) {
      const d = thinPlate('1 mm', placement);
      const ev = build(d);
      expect(totalVolume(ev, d)).toBeCloseTo(expected, 6);
      for (const [role, n] of Object.entries(counts)) expect(facesOf(ev, d, role)).toHaveLength(n);
      expect(facesOf(ev, d, 'start')).toHaveLength(1);
      expect(facesOf(ev, d, 'end')).toHaveLength(1);
      const walls = [...facesOf(ev, d, 'side'), ...facesOf(ev, d, 'inner'), ...facesOf(ev, d, 'outer')];
      expect(new Set(walls.map(identity)).size).toBe(8);
    }
  });

  it('keeps a pick on an inner wall when the wall gets thicker', () => {
    const d1 = thinPlate('1 mm', 'inside');
    const before = build(d1);
    const inner = pick(before, d1, faceAt(before, d1, [19, 5, 2.5]));
    const d2 = thinPlate('2 mm', 'inside');
    const after = build(d2);
    expect(centroid(after, found(after, d2, inner))[0]).toBeCloseTo(18, 9);
  });

  it('makes a wall round each loop of a region with a hole, and round a disc', () => {
    const holed = thinPlate('1 mm', 'inside', (x) => {
      x.rect(0, 0, 20, 10);
      x.circle(10, 5, 2);
    });
    const ev = build(holed);
    expect(totalVolume(ev, holed)).toBeCloseTo((200 - 144) * 5 + Math.PI * (9 - 4) * 5, 6);
    expect(facesOf(ev, holed, 'inner')).toHaveLength(5);

    const disc = thinPlate('1 mm', 'outside', (x) => x.circle(0, 0, 5), [0, 0]);
    const ev2 = build(disc);
    expect(totalVolume(ev2, disc)).toBeCloseTo(Math.PI * (36 - 25) * 5, 6);
    expect(facesOf(ev2, disc, 'side')).toHaveLength(1);
    expect(facesOf(ev2, disc, 'outer')).toHaveLength(1);
  });

  it('extrudes a thin wall up to a face', () => {
    const base = pickInScene(block(0, 20, 20, 25), [10, 5, 20]);
    const d = withNames(scene(block(0, 20, 20, 25)), base.ev);
    const s = d.sketch('xy', (x) => x.rect(8, 3, 4, 4), 5);
    extrude(d, {
      sketch: s.feature,
      profiles: [s.region([9, 4])],
      sides: [side(d, toFace(d, { entity: base.record }))],
      thin: thinWall(d, '1 mm', 'inside'),
    });
    const ev = build(d);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo((16 - 4) * 15, 6);
  });

  it('pauses a wall thicker than the profile, and a tapered thin extrude', () => {
    expect(pauseOf(thinPlate('6 mm', 'inside'))).toBe('the thin wall is thicker than the profile');
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 10));
    extrude(d, {
      sketch: s.feature,
      profiles: [s.region([1, 1])],
      sides: [side(d, distance(d, '5 mm'), '2 deg')],
      thin: thinWall(d, '1 mm', 'inside'),
    });
    expect(pauseOf(d)).toBe('tapered thin extrudes are not built yet');
  });
});

describe('revolves', () => {
  const revolve = (
    d: DocBuilder,
    profiles: Json[],
    axis: Json,
    thin: Json = { solid: {} },
    sides: Json[] = [{ angle: { a: val(d, '90 deg') } }],
  ) =>
    d.feature('core.revolve', {
      profiles: makeSet(profiles),
      axis,
      sides,
      thin,
      operation: { op: val(d, '"new"'), targets: { all: {} }, keepTools: val(d, 'false') },
    });
  const zAxis = (d: DocBuilder) => ({ along: { ref: { standard: { name: 'z' } }, reversed: val(d, 'false') } });

  it('turns a thin wall, naming its faces as a thin extrude does', () => {
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => x.rect(5, 0, 5, 4));
    revolve(d, [s.region([6, 1])], zAxis(d), thinWall(d, '1 mm', 'inside'));
    const ev = build(d);
    const quarter = (r0: number, r1: number, h: number) => (Math.PI * (r1 * r1 - r0 * r0) * h) / 4;
    expect(totalVolume(ev, d)).toBeCloseTo(quarter(5, 10, 4) - quarter(6, 9, 2), 6);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
    expect(facesOf(ev, d, 'inner')).toHaveLength(4);
    expect(facesOf(ev, d, 'start')).toHaveLength(1);
  });

  it('turns a thin wall all the way round, with no caps', () => {
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => x.rect(5, 0, 5, 4));
    revolve(d, [s.region([6, 1])], zAxis(d), thinWall(d, '1 mm', 'inside'), [{ full: {} }]);
    const ev = build(d);
    const ring = (r0: number, r1: number, h: number) => Math.PI * (r1 * r1 - r0 * r0) * h;
    expect(totalVolume(ev, d)).toBeCloseTo(ring(5, 10, 4) - ring(6, 9, 2), 6);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
    expect(facesOf(ev, d, 'inner')).toHaveLength(4);
    expect(facesOf(ev, d, 'start')).toEqual([]);
  });

  it('pauses a thin wall pushed across the axis', () => {
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => x.rect(0.5, 0, 5, 4));
    revolve(d, [s.region([1, 1])], zAxis(d), thinWall(d, '1 mm', 'outside'));
    expect(pauseOf(d)).toBe('the axis crosses the thin wall');
  });

  it('turns about a straight edge of a body, and follows the edge when the body grows', () => {
    // A plate 0..w × 0..10 × 0..5; its edge at x = w, y = 0 runs up z in the XZ plane.
    const plate = (w: number) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.rect(0, 0, w, 10));
      extrude(d, { sketch: s.feature, profiles: [s.region([1, 1])], sides: [side(d, distance(d, '5 mm'))] });
      return d;
    };
    const d0 = plate(20);
    const ev0 = build(d0);
    const edge = all(ev0, d0).find((e) => {
      const m = e.kind === 'edge' ? (ev0.adapter.measures(e.key).midpoint as Vec3) : undefined;
      return m !== undefined && Math.hypot(m[0] - 20, m[1], m[2] - 2.5) < 1e-9;
    }) as NamedEntity;
    const axis = pick(ev0, d0, edge);
    const turnedAbout = (w: number) => {
      const d = withNames(plate(w), ev0);
      const s = d.sketch('xz', (x) => x.rect(30, 0, 3, 3));
      revolve(d, [s.region([31, 1])], { along: { ref: { entity: axis }, reversed: val(d, 'false') } });
      return d;
    };
    const quarter = (r0: number, r1: number) => (Math.PI * (r1 * r1 - r0 * r0) * 3) / 4;
    const d1 = turnedAbout(20);
    const before = build(d1);
    const ring = bodies(before, d1).find((b) => b.createdAt > 1) as NamedEntity;
    expect(volume(before, ring)).toBeCloseTo(quarter(10, 13), 6);
    const outer = facesOf(before, d1, 'side').find((e) => {
      const g = before.adapter.faceGeometry(e.key).surface;
      return g.kind === 'cylinder' && Math.abs((g.radii[0] as number) - 13) < 1e-6;
    }) as NamedEntity;
    const outerPick = pick(before, d1, outer);

    const d2 = turnedAbout(24);
    const after = build(d2);
    expect(volume(after, bodies(after, d2).find((b) => b.createdAt > 1) as NamedEntity)).toBeCloseTo(quarter(6, 9), 6);
    const g = after.adapter.faceGeometry(found(after, d2, outerPick)).surface;
    expect(g.kind === 'cylinder' ? g.radii[0] : 0).toBeCloseTo(9, 6);
  });
});
