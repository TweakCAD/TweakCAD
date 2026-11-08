/**
 * Where an extrude starts (appendix A `start`) on the real kernel: at an
 * offset from the sketch plane, on a plane or face parallel to it, on a
 * slanted face and on a cylinder. Picks made on the result before an edit
 * resolve after it to the face that is geometrically the same, also when the
 * start face turns from parallel to slanted; the cases that should pause do.
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
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const bbox = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).bbox as [Vec3, Vec3];
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
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
const fromFace = (d: DocBuilder, face: Json, offset = '0 mm') => ({ object: { face, offset: val(d, offset) } });

interface Extrude {
  sketch: string;
  profiles: Json[];
  sides: Json[];
  start?: Json;
  thin?: Json;
  op?: 'new' | 'join' | 'cut';
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
    ...(o.start ? { start: o.start } : {}),
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
 * A ramp along x, 30 long and 12 deep (y from 0 to 12), its floor at z = 0
 * and its top rising from z = `low` at x = 0 to `high` at x = 30.
 */
const ramp = (low: number, high: number) => (d: DocBuilder) => {
  // On the XZ plane sketch y is world −Z and the normal is +Y.
  const s = d.sketch('xz', (x) =>
    polygon(x, [
      [0, 0],
      [30, 0],
      [30, -high],
      [0, -low],
    ]),
  );
  extrude(d, { sketch: s.feature, profiles: [s.region([1, -0.5])], sides: [side(d, distance(d, '12 mm'))] });
};

/** A rod along y from y = −2, 14 long, radius 8, its axis at x = 10 and height 30. */
const rod = (d: DocBuilder) => {
  const s = d.sketch('xz', (x) => x.circle(10, -30, 8), -2);
  extrude(d, { sketch: s.feature, profiles: [s.region([10, -30])], sides: [side(d, distance(d, '14 mm'))] });
};

/** The body made last. */
const postOf = (ev: Evaluation, d: DocBuilder) =>
  bodies(ev, d).sort((a, b) => b.createdAt - a.createdAt)[0] as NamedEntity;
/** The faces of the post with a role. */
const postFaces = (ev: Evaluation, d: DocBuilder, role: string) =>
  all(ev, d).filter((e) => e.kind === 'face' && roleOf(ev, e) === role && e.createdBy === postOf(ev, d).createdBy);

/**
 * `base` (if any), then a 4 × 4 post on the XY plane at height `z`, x from
 * 8 to 12 and y from 3 to 7, extruded by `sides` from `start`.
 */
function post(
  base: ((d: DocBuilder) => void) | undefined,
  sides: (d: DocBuilder) => Json[],
  start?: (d: DocBuilder) => Json,
  more: Partial<Extrude> = {},
  z = 0,
): DocBuilder {
  const d = new DocBuilder();
  base?.(d);
  const s = d.sketch('xy', (x) => x.rect(8, 3, 4, 4), z);
  extrude(d, {
    sketch: s.feature,
    profiles: [s.region([9, 4])],
    sides: sides(d),
    ...(start ? { start: start(d) } : {}),
    ...more,
  });
  return d;
}

/** Builds `base` alone and picks its face at `at`. */
function pickIn(base: (d: DocBuilder) => void, at: Vec3): { ev: Evaluation; record: EntityRecord } {
  const d = new DocBuilder();
  base(d);
  const ev = build(d);
  return { ev, record: pick(ev, d, faceAt(ev, d, at)) };
}

describe('extrude start at an offset', () => {
  it('moves the profile along the direction, and against it for a negative offset', { timeout: 60_000 }, () => {
    const up = post(
      undefined,
      (d) => [side(d, distance(d, '5 mm'))],
      (d) => ({ offset: { d: val(d, '3 mm') } }),
    );
    const ev = build(up);
    expect(volume(ev, postOf(ev, up))).toBeCloseTo(80, 6);
    expect(bbox(ev, postOf(ev, up).key)[0][2]).toBeCloseTo(3, 9);
    expect(centroid(ev, (postFaces(ev, up, 'start')[0] as NamedEntity).key)[2]).toBeCloseTo(3, 9);

    // Reversed, the offset runs along the reversed direction.
    const down = post(
      undefined,
      (d) => [side(d, distance(d, '5 mm'))],
      (d) => ({ offset: { d: val(d, '3 mm') } }),
      { reversed: true },
    );
    const ev2 = build(down);
    expect(bbox(ev2, postOf(ev2, down).key)[1][2]).toBeCloseTo(-3, 9);
    expect(bbox(ev2, postOf(ev2, down).key)[0][2]).toBeCloseTo(-8, 9);

    const back = post(
      undefined,
      (d) => [side(d, distance(d, '5 mm'))],
      (d) => ({ offset: { d: val(d, '-2 mm') } }),
    );
    const ev3 = build(back);
    expect(bbox(ev3, postOf(ev3, back).key)[0][2]).toBeCloseTo(-2, 9);
  });

  it('reads as the sketch plane without a start or with profilePlane', { timeout: 60_000 }, () => {
    for (const start of [undefined, () => ({ profilePlane: {} })]) {
      const d = post(undefined, (x) => [side(x, distance(x, '5 mm'))], start);
      const ev = build(d);
      expect(bbox(ev, postOf(ev, d).key)[0][2]).toBeCloseTo(0, 9);
    }
  });

  it('tapers about the start', { timeout: 60_000 }, () => {
    const d = post(
      undefined,
      (x) => [side(x, distance(x, '10 mm'), '5 deg')],
      (x) => ({ offset: { d: val(x, '7 mm') } }),
    );
    const ev = build(d);
    const t = Math.tan((5 * Math.PI) / 180);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(16 * 10 + 8 * t * 100 + (4 / 3) * t * t * 1000, 6);
    const start = postFaces(ev, d, 'start')[0] as NamedEntity;
    expect(centroid(ev, start.key)[2]).toBeCloseTo(7, 9);
    expect(ev.adapter.measures(start.key).area).toBeCloseTo(16, 6);
  });
});

describe('extrude start on a plane or face parallel to the sketch', () => {
  /** A 20 × 10 plate of thickness `h` on the XY plane. */
  const plate = (h: number) => (d: DocBuilder) => {
    const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 10));
    extrude(d, { sketch: s.feature, profiles: [s.region([1, 1])], sides: [side(d, distance(d, `${h} mm`))] });
  };

  it('moves the profile onto a default plane, and onto a face, with the offset past it', { timeout: 60_000 }, () => {
    const onPlane = post(
      undefined,
      (d) => [side(d, distance(d, '5 mm'))],
      (d) => fromFace(d, { standard: { name: 'xy' } }, '2 mm'),
      {},
      9,
    );
    const ev = build(onPlane);
    expect(bbox(ev, postOf(ev, onPlane).key)[0][2]).toBeCloseTo(2, 9);

    const top = pickIn(plate(5), [10, 5, 5]);
    const d = withNames(
      post(
        plate(5),
        (x) => [side(x, distance(x, '5 mm'))],
        (x) => fromFace(x, { entity: top.record }, '1 mm'),
      ),
      top.ev,
    );
    const ev2 = build(d);
    expect(volume(ev2, postOf(ev2, d))).toBeCloseTo(80, 6);
    expect(bbox(ev2, postOf(ev2, d).key)[0][2]).toBeCloseTo(6, 9);
  });

  it('follows the face when the plate gets thicker, and keeps picks on the post', { timeout: 60_000 }, () => {
    const top = pickIn(plate(5), [10, 5, 5]);
    const onTop = (h: number) =>
      withNames(
        post(
          plate(h),
          (x) => [side(x, distance(x, '5 mm'))],
          (x) => fromFace(x, { entity: top.record }),
        ),
        top.ev,
      );
    const d1 = onTop(5);
    const before = build(d1);
    const cap = pick(before, d1, postFaces(before, d1, 'end')[0] as NamedEntity);
    const wall = pick(before, d1, faceAt(before, d1, [12, 5, 7.5]));
    const d2 = onTop(8);
    const after = build(d2);
    expect(centroid(after, found(after, d2, cap))[2]).toBeCloseTo(13, 9);
    const w = centroid(after, found(after, d2, wall));
    expect(w[0]).toBeCloseTo(12, 9);
    expect(w[2]).toBeCloseTo(10.5, 9);
  });
});

describe('extrude start on a slanted face', () => {
  const top = (low: number, high: number) => pickIn(ramp(low, high), [15, 6, (low + high) / 2]);

  it(
    'starts on the face, both caps taking its slope, and each wall named after its sketch line',
    { timeout: 60_000 },
    () => {
      const t = top(5, 15);
      const d = withNames(
        post(
          ramp(5, 15),
          (x) => [side(x, distance(x, '5 mm'))],
          (x) => fromFace(x, { entity: t.record }),
        ),
        t.ev,
      );
      const ev = build(d);
      // A sheared prism: the profile's area times the length along the direction.
      expect(volume(ev, postOf(ev, d))).toBeCloseTo(80, 6);
      const [start] = postFaces(ev, d, 'start') as [NamedEntity];
      const [end] = postFaces(ev, d, 'end') as [NamedEntity];
      expect(postFaces(ev, d, 'start')).toHaveLength(1);
      expect(postFaces(ev, d, 'end')).toHaveLength(1);
      // The ramp's top at x = 10 is 5 + 10 / 3.
      expect(centroid(ev, start.key)[2]).toBeCloseTo(5 + 10 / 3, 6);
      expect(centroid(ev, end.key)[2]).toBeCloseTo(10 + 10 / 3, 6);
      const n = ev.adapter.faceGeometry(end.key).surface.normal as Vec3;
      expect(Math.abs(n[0] / n[2])).toBeCloseTo(1 / 3, 9);
      const walls = postFaces(ev, d, 'side');
      expect(walls).toHaveLength(4);
      expect(new Set(walls.map(identity)).size).toBe(4);
    },
  );

  it('starts on the face from a sketch above it, the face lying behind the sketch plane', { timeout: 60_000 }, () => {
    const t = top(5, 15);
    const d = withNames(
      post(
        ramp(5, 15),
        (x) => [side(x, distance(x, '5 mm'))],
        (x) => fromFace(x, { entity: t.record }),
        {},
        40,
      ),
      t.ev,
    );
    const ev = build(d);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo(80, 6);
    expect(centroid(ev, (postFaces(ev, d, 'start')[0] as NamedEntity).key)[2]).toBeCloseTo(5 + 10 / 3, 6);
  });

  it(
    'keeps picks on the caps and walls when the slope changes, and when the face turns from level to slanted',
    { timeout: 60_000 },
    () => {
      const t = top(5, 15);
      const posted = (low: number, high: number) =>
        withNames(
          post(
            ramp(low, high),
            (x) => [side(x, distance(x, '5 mm'))],
            (x) => fromFace(x, { entity: t.record }),
          ),
          t.ev,
        );
      const d1 = posted(5, 15);
      const before = build(d1);
      const end = pick(before, d1, postFaces(before, d1, 'end')[0] as NamedEntity);
      const start = pick(before, d1, postFaces(before, d1, 'start')[0] as NamedEntity);
      const plusX = (ev: Evaluation, d: DocBuilder) =>
        postFaces(ev, d, 'side').find((e) => Math.abs(centroid(ev, e.key)[0] - 12) < 1e-6) as NamedEntity;
      const wall = pick(before, d1, plusX(before, d1));

      for (const [low, high] of [
        [5, 25],
        [5, 5],
        [8, 2],
      ] as const) {
        const d2 = posted(low, high);
        const after = build(d2);
        const at = low + ((high - low) * 10) / 30;
        expect(centroid(after, found(after, d2, end))[2]).toBeCloseTo(at + 5, 6);
        expect(centroid(after, found(after, d2, start))[2]).toBeCloseTo(at, 6);
        expect(found(after, d2, wall)).toBe(plusX(after, d2).key);
      }

      // Picks made while the face was level resolve once it slants.
      const d3 = posted(5, 5);
      const level = build(d3);
      const levelEnd = pick(level, d3, postFaces(level, d3, 'end')[0] as NamedEntity);
      const levelWall = pick(level, d3, plusX(level, d3));
      const d4 = withNames(posted(5, 15), level);
      const slanted = build(d4);
      expect(centroid(slanted, found(slanted, d4, levelEnd))[2]).toBeCloseTo(10 + 10 / 3, 6);
      expect(found(slanted, d4, levelWall)).toBe(plusX(slanted, d4).key);
    },
  );

  it('runs a symmetric extent and two sides from the face, and up to a face', { timeout: 60_000 }, () => {
    const t = top(5, 15);
    const sym = withNames(
      post(
        ramp(5, 15),
        (x) => [{ extent: { symmetric: { d: val(x, '6 mm'), measure: val(x, '"total"') } }, taper: val(x, '0 deg') }],
        (x) => fromFace(x, { entity: t.record }),
      ),
      t.ev,
    );
    const ev = build(sym);
    expect(volume(ev, postOf(ev, sym))).toBeCloseTo(96, 6);
    expect(centroid(ev, (postFaces(ev, sym, 'start')[0] as NamedEntity).key)[2]).toBeCloseTo(5 + 10 / 3 - 3, 6);

    const two = withNames(
      post(
        ramp(5, 15),
        (x) => [side(x, distance(x, '4 mm')), side(x, distance(x, '-1 mm'))],
        (x) => fromFace(x, { entity: t.record }),
      ),
      t.ev,
    );
    const ev2 = build(two);
    expect(volume(ev2, postOf(ev2, two))).toBeCloseTo(48, 6);
    expect(centroid(ev2, (postFaces(ev2, two, 'start')[0] as NamedEntity).key)[2]).toBeCloseTo(5 + 10 / 3 + 1, 6);

    // Up to a roof whose underside is at z = 40.
    const roofed = (d: DocBuilder) => {
      ramp(5, 15)(d);
      const s = d.sketch('xy', (x) => x.rect(0, -2, 30, 14), 40);
      extrude(d, { sketch: s.feature, profiles: [s.region([1, 1])], sides: [side(d, distance(d, '5 mm'))] });
    };
    const under = pickIn(roofed, [15, 5, 40]);
    const tr = pickIn(roofed, [15, 6, 10]);
    const up = withNames(
      withNames(
        post(
          roofed,
          (x) => [side(x, { toFace: { face: { entity: under.record }, offset: val(x, '0 mm') } })],
          (x) => fromFace(x, { entity: tr.record }),
        ),
        under.ev,
      ),
      tr.ev,
    );
    const ev3 = build(up);
    expect(volume(ev3, postOf(ev3, up))).toBeCloseTo(16 * (40 - 5 - 10 / 3), 6);
  });

  it('makes a thin wall from the face', { timeout: 60_000 }, () => {
    const t = top(5, 15);
    const d = new DocBuilder();
    ramp(5, 15)(d);
    const s = d.sketch('xy', (x) => x.rect(8, 3, 4, 4));
    extrude(d, {
      sketch: s.feature,
      profiles: [s.region([9, 4])],
      sides: [side(d, distance(d, '5 mm'))],
      start: fromFace(d, { entity: t.record }),
      thin: { thin: { thickness: val(d, '1 mm'), placement: val(d, '"inside"') } },
    });
    withNames(d, t.ev);
    const ev = build(d);
    expect(volume(ev, postOf(ev, d))).toBeCloseTo((16 - 4) * 5, 6);
  });
});

describe('extrude start on a cylinder', () => {
  /** A rod along y from y = −2, 14 long, radius 8, its axis at x = 10 and height `z`. */
  const rodAt = (z: number) => (d: DocBuilder) => {
    const s = d.sketch('xz', (x) => x.circle(10, -z, 8), -2);
    extrude(d, { sketch: s.feature, profiles: [s.region([10, -z])], sides: [side(d, distance(d, '14 mm'))] });
  };
  const onRod = (
    lateral: { ev: Evaluation; record: EntityRecord },
    sketchZ: number,
    more: Partial<Extrude> = {},
    z = 30,
  ) =>
    withNames(
      post(
        rodAt(z),
        (x) => [side(x, distance(x, '3 mm'))],
        (x) => fromFace(x, { entity: lateral.record }),
        more,
        sketchZ,
      ),
      lateral.ev,
    );
  /** The mean height of the rod's underside (`sign` −1) or top (1) over x from 8 to 12. */
  const surfaceHeight = (sign: number, z = 30) => {
    let s = 0;
    for (let i = 0; i < 20000; i++) s += z + sign * Math.sqrt(64 - (8 + ((i + 0.5) * 4) / 20000 - 10) ** 2);
    return s / 20000;
  };

  it(
    'starts where the profile first meets the rod ahead of the sketch, or behind it when none is ahead',
    { timeout: 60_000 },
    () => {
      const lateral = pickIn(rod, [10, 5, 30]);
      const below = onRod(lateral, 0);
      const ev = build(below);
      expect(volume(ev, postOf(ev, below))).toBeCloseTo(48, 3);
      const start = postFaces(ev, below, 'start');
      expect(start).toHaveLength(1);
      expect(ev.adapter.faceGeometry((start[0] as NamedEntity).key).surface.kind).toBe('cylinder');
      expect(bbox(ev, postOf(ev, below).key)[0][2]).toBeCloseTo(22, 6);

      const above = onRod(lateral, 50);
      const ev2 = build(above);
      expect(volume(ev2, postOf(ev2, above))).toBeCloseTo(48, 3);
      expect(bbox(ev2, postOf(ev2, above).key)[1][2]).toBeCloseTo(41, 6);

      // From above, extruding down: the top of the rod is ahead.
      const down = onRod(lateral, 50, { reversed: true });
      const ev3 = build(down);
      expect(volume(ev3, postOf(ev3, down))).toBeCloseTo(48, 3);
      expect(bbox(ev3, postOf(ev3, down).key)[1][2]).toBeCloseTo(38, 6);
      expect(centroid(ev3, (postFaces(ev3, down, 'start')[0] as NamedEntity).key)[2]).toBeCloseTo(surfaceHeight(1), 2);
    },
  );

  it('keeps a pick on the curved end cap when the rod rises', { timeout: 60_000 }, () => {
    const lateral = pickIn(rod, [10, 5, 30]);
    const d1 = onRod(lateral, 0);
    const before = build(d1);
    const cap = pick(before, d1, postFaces(before, d1, 'end')[0] as NamedEntity);
    const d2 = onRod(lateral, 0, {}, 34);
    const after = build(d2);
    const key = found(after, d2, cap);
    expect(after.adapter.faceGeometry(key).surface.kind).toBe('cylinder');
    expect(centroid(after, key)[2]).toBeCloseTo(surfaceHeight(-1, 34) + 3, 2);
  });
});

describe('extrude start and stop on a construction plane', () => {
  /** A construction plane parallel to XY at height `z`, and an axis along z. */
  const planes = (d: DocBuilder, z: number) => ({
    plane: d.feature('core.constructionPlane', {
      frame: { fixed: { placement: val(d, `placement(vector(0 mm, 0 mm, ${z} mm), rotate(vector(0, 0, 1), 0 deg))`) } },
    }),
    axis: d.feature('core.constructionAxis', {
      frame: { fixed: { placement: val(d, 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))') } },
    }),
  });
  const object = (id: string) => ({ object: { feature: { id } } });

  it('starts on the plane with the offset past it, and stops on it with the offset', { timeout: 60_000 }, () => {
    const start = new DocBuilder();
    const a = planes(start, 4);
    const s = start.sketch('xy', (x) => x.rect(8, 3, 4, 4));
    extrude(start, {
      sketch: s.feature,
      profiles: [s.region([9, 4])],
      sides: [side(start, distance(start, '5 mm'))],
      start: fromFace(start, object(a.plane), '1 mm'),
    });
    const ev = build(start);
    expect(bbox(ev, postOf(ev, start).key)[0][2]).toBeCloseTo(5, 9);
    expect(bbox(ev, postOf(ev, start).key)[1][2]).toBeCloseTo(10, 9);

    const stop = new DocBuilder();
    const b = planes(stop, 7);
    const t = stop.sketch('xy', (x) => x.rect(8, 3, 4, 4));
    extrude(stop, {
      sketch: t.feature,
      profiles: [t.region([9, 4])],
      sides: [side(stop, { toFace: { face: object(b.plane), offset: val(stop, '-2 mm') } })],
    });
    const ev2 = build(stop);
    expect(volume(ev2, postOf(ev2, stop))).toBeCloseTo(16 * 5, 6);
    expect(bbox(ev2, postOf(ev2, stop).key)[1][2]).toBeCloseTo(5, 9);
  });

  it('pauses a construction axis as the start or the stop', { timeout: 60_000 }, () => {
    const start = new DocBuilder();
    const a = planes(start, 4);
    const s = start.sketch('xy', (x) => x.rect(8, 3, 4, 4));
    extrude(start, {
      sketch: s.feature,
      profiles: [s.region([9, 4])],
      sides: [side(start, distance(start, '5 mm'))],
      start: fromFace(start, object(a.axis)),
    });
    expect(pauseOf(start)).toBe('a construction axis is not a face to start an extrude from');

    const stop = new DocBuilder();
    const b = planes(stop, 4);
    const t = stop.sketch('xy', (x) => x.rect(8, 3, 4, 4));
    extrude(stop, {
      sketch: t.feature,
      profiles: [t.region([9, 4])],
      sides: [side(stop, { toFace: { face: object(b.axis), offset: val(stop, '0 mm') } })],
    });
    expect(pauseOf(stop)).toBe('a construction axis is not a face to extrude to');
  });
});

describe('extrude start pauses', () => {
  it(
    'pauses a start plane the direction runs along, a start the profile misses, and a taper from a slanted face',
    { timeout: 60_000 },
    () => {
      expect(
        pauseOf(
          post(
            undefined,
            (d) => [side(d, distance(d, '5 mm'))],
            (d) => fromFace(d, { standard: { name: 'xz' } }),
          ),
        ),
      ).toBe('the extrude runs along its start plane');

      const lateral = pickIn(rod, [10, 5, 30]);
      const off = new DocBuilder();
      rod(off);
      const s = off.sketch('xy', (x) => x.rect(40, 3, 4, 4));
      extrude(off, {
        sketch: s.feature,
        profiles: [s.region([41, 4])],
        sides: [side(off, distance(off, '3 mm'))],
        start: fromFace(off, { entity: lateral.record }),
      });
      expect(pauseOf(withNames(off, lateral.ev))).toBe('the profile does not reach the start face');

      const t = pickIn(ramp(5, 15), [15, 6, 10]);
      const tapered = withNames(
        post(
          ramp(5, 15),
          (x) => [side(x, distance(x, '5 mm'), '3 deg')],
          (x) => fromFace(x, { entity: t.record }),
        ),
        t.ev,
      );
      expect(pauseOf(tapered)).toBe('a tapered extrude from a face not parallel to its sketch is not built yet');
    },
  );
});
