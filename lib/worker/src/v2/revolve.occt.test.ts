/**
 * Revolve on the real kernel: partial and full turns, every axis form,
 * profiles touching the axis, join and cut, edits that keep a pick on its
 * face, and the cases that pause.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
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
import { DocBuilder, type SketchDraw, type SketchHandle } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';

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

function evaluate(doc: Json, solve: boolean): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k, solve ? { solver: gcs } : {});
  builds.push(ev);
  return ev;
}

function build(d: DocBuilder, solve = false): Evaluation {
  const ev = evaluate(d.document(), solve);
  expect(ev.pauses).toEqual([]);
  return ev;
}

/** The one pause a document ends on. */
function pauseOf(d: DocBuilder): string {
  const { pauses } = evaluate(d.document(), false);
  expect(pauses).toHaveLength(1);
  return (pauses[0] as { message: string }).message;
}

const all = (ev: Evaluation, d: DocBuilder) => [...(ev.parts.get(d.partId)?.state.entities.values() ?? [])];
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const area = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).area as number;
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const facesOf = (ev: Evaluation, d: DocBuilder, role: string) =>
  all(ev, d).filter((e) => e.kind === 'face' && roleOf(ev, e) === role);
const largest = (ev: Evaluation, faces: NamedEntity[]) =>
  [...faces].sort((a, b) => area(ev, b.key) - area(ev, a.key))[0] as NamedEntity;

/** The face a pick resolves to, which must be one. */
function found(ev: Evaluation, d: DocBuilder, record: EntityRecord): ShapeKey {
  const result = resolve(record, ev.parts.get(d.partId)!.state, ev.adapter);
  expect(result.outcome).toBe('same');
  return result.outcome === 'same' ? (result.entities[0]?.key as ShapeKey) : -1;
}

const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) =>
  writeRecord(e, ev.parts.get(d.partId)!.state, ev.adapter);

const angle = (d: DocBuilder, a: string) => ({ angle: { a: d.val(a) } });
const along = (d: DocBuilder, ref: Json, reversed = false) => ({ along: { ref, reversed: d.val(String(reversed)) } });
const standardZ = (d: DocBuilder, reversed = false) => along(d, { standard: { name: 'z' } }, reversed);
const through = (d: DocBuilder, x: number, y: number, z: number, axis: 'x' | 'y' | 'z') => ({
  through: {
    point: { at: { v: d.val(`vector(${x} mm, ${y} mm, ${z} mm)`) } },
    direction: { axis: { axis: d.val(`"${axis}"`), reversed: d.val('false') } },
  },
});

/** A reference to a sketch curve. */
function curveRef(d: DocBuilder, feature: string, curve: string): Json {
  const ladder = ladderOf({ kind: 'curve', chain: [], feature, role: 'curve', src: [idItem(curve)] }, d.names);
  return { entity: { id: ladder, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
}

/** Marks the line just drawn as construction geometry. */
function construction(d: DocBuilder, x: SketchDraw): void {
  (x.curves[x.curves.length - 1] as Json).construction = d.val('true');
}

interface RevolveOptions {
  profiles: Json[];
  axis?: Json;
  sides?: Json[];
  thin?: Json;
  op?: 'new' | 'join' | 'cut' | 'intersect';
}

function revolve(d: DocBuilder, o: RevolveOptions): string {
  return d.feature('core.revolve', {
    profiles: makeSet(o.profiles),
    axis: o.axis ?? standardZ(d),
    sides: o.sides ?? [angle(d, '90 deg')],
    thin: o.thin ?? { solid: {} },
    operation: { op: d.val(`"${o.op ?? 'new'}"`), targets: { all: {} }, keepTools: d.val('false') },
  });
}

/** On the XZ plane sketch x is world X and sketch y is world −Z. */
function ringSketch(d: DocBuilder, inner = 5, outer = 10, height = 4): SketchHandle {
  return d.sketch('xz', (x) => x.rect(inner, 0, outer - inner, height));
}

/** A rectangle from radius `inner` to `outer`, `height` tall, turned about Z by `sides`. */
function ring(sides: (d: DocBuilder) => Json[], inner = 5, outer = 10, height = 4, reversed = false): DocBuilder {
  const d = new DocBuilder();
  const s = ringSketch(d, inner, outer, height);
  revolve(d, { profiles: [s.region([inner + 1, 1])], sides: sides(d), axis: standardZ(d, reversed) });
  return d;
}

/** The volume of a ring turned by `degrees`. */
const ringVolume = (degrees: number, inner = 5, outer = 10, height = 4) =>
  Math.PI * (outer * outer - inner * inner) * height * (degrees / 360);

describe('revolve', () => {
  it('turns a rectangle by 90 and by 270 degrees', () => {
    for (const degrees of [90, 270]) {
      const d = ring((x) => [angle(x, `${degrees} deg`)]);
      const ev = build(d);
      const found = bodies(ev, d);
      expect(found).toHaveLength(1);
      expect(volume(ev, found[0] as NamedEntity)).toBeCloseTo(ringVolume(degrees), 6);
      expect(facesOf(ev, d, 'side')).toHaveLength(4);
      expect(facesOf(ev, d, 'start')).toHaveLength(1);
      expect(facesOf(ev, d, 'end')).toHaveLength(1);
    }
  });

  it('starts on the sketch and turns by the right hand about the axis', () => {
    const forward = ring((x) => [angle(x, '90 deg')]);
    const ev = build(forward);
    const start = centroid(ev, (facesOf(ev, forward, 'start')[0] as NamedEntity).key);
    const end = centroid(ev, (facesOf(ev, forward, 'end')[0] as NamedEntity).key);
    expect(start).toEqual([expect.closeTo(7.5, 9), expect.closeTo(0, 9), expect.closeTo(-2, 9)]);
    expect(end).toEqual([expect.closeTo(0, 9), expect.closeTo(7.5, 9), expect.closeTo(-2, 9)]);

    const reversed = ring((x) => [angle(x, '90 deg')], 5, 10, 4, true);
    const ev2 = build(reversed);
    const end2 = centroid(ev2, (facesOf(ev2, reversed, 'end')[0] as NamedEntity).key);
    expect(end2).toEqual([expect.closeTo(0, 9), expect.closeTo(-7.5, 9), expect.closeTo(-2, 9)]);
    expect(volume(ev2, bodies(ev2, reversed)[0] as NamedEntity)).toBeCloseTo(ringVolume(90), 6);
  });

  it('turns both ways and symmetrically, starting behind the sketch', () => {
    const two = ring((x) => [angle(x, '90 deg'), angle(x, '30 deg')]);
    const ev = build(two);
    expect(volume(ev, bodies(ev, two)[0] as NamedEntity)).toBeCloseTo(ringVolume(120), 6);
    expect(facesOf(ev, two, 'side')).toHaveLength(4);
    const start = centroid(ev, (facesOf(ev, two, 'start')[0] as NamedEntity).key);
    const back = (-30 * Math.PI) / 180;
    expect(start).toEqual([
      expect.closeTo(7.5 * Math.cos(back), 9),
      expect.closeTo(7.5 * Math.sin(back), 9),
      expect.closeTo(-2, 9),
    ]);

    const total = ring((x) => [{ symmetric: { a: x.val('60 deg'), measure: x.val('"total"') } }]);
    const ev2 = build(total);
    expect(volume(ev2, bodies(ev2, total)[0] as NamedEntity)).toBeCloseTo(ringVolume(60), 6);
    const half = ring((x) => [{ symmetric: { a: x.val('60 deg'), measure: x.val('"half"') } }]);
    const ev3 = build(half);
    expect(volume(ev3, bodies(ev3, half)[0] as NamedEntity)).toBeCloseTo(ringVolume(120), 6);
  });

  it('takes a sketch line, reversed or not, or a point and a direction as the axis', () => {
    const onLine = (reversed: boolean) => {
      const d = new DocBuilder();
      let axis = '';
      const s = d.sketch('xz', (x) => {
        x.rect(5, 0, 5, 4);
        axis = x.line(x.point(0, 0), x.point(0, 10));
        construction(d, x);
      });
      revolve(d, { profiles: [s.region([6, 1])], axis: along(d, curveRef(d, s.feature, axis), reversed) });
      return d;
    };
    const line = onLine(false);
    const ev = build(line);
    expect(volume(ev, bodies(ev, line)[0] as NamedEntity)).toBeCloseTo(ringVolume(90), 6);
    // The line runs along world −Z, so the right-hand turn about it goes toward −Y.
    expect(centroid(ev, (facesOf(ev, line, 'end')[0] as NamedEntity).key)[1]).toBeCloseTo(-7.5, 9);
    const flipped = onLine(true);
    const ev2 = build(flipped);
    expect(centroid(ev2, (facesOf(ev2, flipped, 'end')[0] as NamedEntity).key)[1]).toBeCloseTo(7.5, 9);

    // An axis away from the origin: radii 2 to 7 about x = 3.
    const d = new DocBuilder();
    const s = ringSketch(d);
    revolve(d, { profiles: [s.region([6, 1])], axis: through(d, 3, 0, 0, 'z') });
    const ev3 = build(d);
    expect(volume(ev3, bodies(ev3, d)[0] as NamedEntity)).toBeCloseTo(ringVolume(90, 2, 7), 6);
  });

  it('keeps the end cap of a profile with an edge on the axis, which makes no wall', () => {
    const edge = (reversed: boolean) => ring((x) => [angle(x, '90 deg')], 0, 10, 4, reversed);
    for (const reversed of [false, true]) {
      const d = edge(reversed);
      const ev = build(d);
      expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(ringVolume(90, 0), 6);
      expect(facesOf(ev, d, 'side')).toHaveLength(3);
      expect(facesOf(ev, d, 'start')).toHaveLength(1);
      const end = facesOf(ev, d, 'end');
      expect(end).toHaveLength(1);
      expect(centroid(ev, (end[0] as NamedEntity).key)).toEqual([
        expect.closeTo(0, 9),
        expect.closeTo(reversed ? -5 : 5, 9),
        expect.closeTo(-2, 9),
      ]);
    }
    const two = ring((x) => [angle(x, '45 deg'), angle(x, '45 deg')], 0);
    const ev = build(two);
    expect(volume(ev, bodies(ev, two)[0] as NamedEntity)).toBeCloseTo(ringVolume(90, 0), 6);
    expect(facesOf(ev, two, 'end')).toHaveLength(1);
  });

  it('turns a profile with only a corner on the axis', () => {
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => {
      const p = [x.point(0, 0), x.point(10, 0), x.point(10, 5)] as const;
      p.forEach((q, i) => x.line(q, p[(i + 1) % 3] as string));
    });
    revolve(d, { profiles: [s.region([8, 1])] });
    const ev = build(d);
    // A cylinder less a cone, a quarter of it: π r² h (1 - 1/3) / 4.
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo((Math.PI * 100 * 5 * (2 / 3)) / 4, 6);
    expect(facesOf(ev, d, 'side')).toHaveLength(3);
    expect(facesOf(ev, d, 'end')).toHaveLength(1);
  });

  it('turns a disc, and arcs named after their own circles', () => {
    const disc = new DocBuilder();
    const s = disc.sketch('xz', (x) => x.circle(10, 0, 2));
    revolve(disc, { profiles: [s.region([10, 0])] });
    const ev = build(disc);
    // Pappus: area times the path of its centroid.
    expect(volume(ev, bodies(ev, disc)[0] as NamedEntity)).toBeCloseTo(Math.PI * 4 * 10 * (Math.PI / 2), 6);
    expect(facesOf(ev, disc, 'side')).toHaveLength(1);

    const lens = (x0: number) => {
      const d = new DocBuilder();
      const t = d.sketch('xz', (x) => {
        x.circle(10, 0, 3);
        x.circle(13, 0, 3);
      });
      revolve(d, { profiles: [t.region([11.5, 0])], axis: through(d, x0, 0, 0, 'z') });
      return d;
    };
    const clear = lens(13.5);
    const ev2 = build(clear);
    expect(facesOf(ev2, clear, 'side')).toHaveLength(2);
    expect(volume(ev2, bodies(ev2, clear)[0] as NamedEntity)).toBeGreaterThan(0);
    // Both corners of the lens lie on one side; only an arc's crest passes the axis.
    expect(pauseOf(lens(12.9))).toBe('the axis crosses the profile');
  });

  it('makes one body per separate profile', () => {
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => {
      x.rect(5, 0, 5, 4);
      x.rect(20, 0, 5, 4);
    });
    revolve(d, { profiles: [s.region([6, 1]), s.region([21, 1])] });
    const ev = build(d);
    const found = bodies(ev, d).sort((a, b) => volume(ev, a) - volume(ev, b));
    expect(found).toHaveLength(2);
    expect(volume(ev, found[0] as NamedEntity)).toBeCloseTo(ringVolume(90), 6);
    expect(volume(ev, found[1] as NamedEntity)).toBeCloseTo(ringVolume(90, 20, 25), 6);
    expect(found[0]?.ladder).not.toEqual(found[1]?.ladder);
  });

  /** A 40 × 40 plate 5 thick, centred on the origin, then `more`. */
  function plate(more?: (d: DocBuilder) => void): DocBuilder {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(-20, -20, 40, 40));
    d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: '5 mm' }] });
    more?.(d);
    return d;
  }

  it('joins onto an extruded plate, keeping the plate body', () => {
    const plain = plate();
    const plainBuild = build(plain);
    const d = plate((x) => {
      // Sketch y −9 to −5 is world z 5 to 9, standing on the plate.
      const s = x.sketch('xz', (y) => y.rect(5, -9, 5, 4));
      revolve(x, { profiles: [s.region([6, -6])], sides: [angle(x, '270 deg')], op: 'join' });
    });
    const ev = build(d);
    const [body] = bodies(ev, d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(volume(ev, body as NamedEntity)).toBeCloseTo(40 * 40 * 5 + ringVolume(270), 6);
    expect(body?.ladder).toEqual(bodies(plainBuild, plain)[0]?.ladder);
    // Three walls stand clear of the plate; the fourth lies on it and is gone. The plate has its own.
    const above = (role: string) => facesOf(ev, d, role).filter((e) => centroid(ev, e.key)[2] > 5 + 1e-6);
    expect(above('side')).toHaveLength(3);
    expect(above('start')).toHaveLength(1);
    expect(above('end')).toHaveLength(1);
  });

  it('cuts a groove into the plate', () => {
    const d = plate((x) => {
      const s = x.sketch('xz', (y) => y.rect(5, -7, 5, 4));
      revolve(x, { profiles: [s.region([6, -4])], sides: [angle(x, '180 deg')], op: 'cut' });
    });
    const ev = build(d);
    // The tool runs from z = 3 to 7; the plate ends at 5.
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(40 * 40 * 5 - ringVolume(180, 5, 10, 2), 6);
  });

  it('keeps picks on a wall and the end cap when the angle changes and the profile moves', () => {
    const d1 = ring((x) => [angle(x, '90 deg')]);
    const before = build(d1);
    const wall = pick(before, d1, largest(before, facesOf(before, d1, 'side')));
    const end = pick(before, d1, facesOf(before, d1, 'end')[0] as NamedEntity);
    expect(area(before, largest(before, facesOf(before, d1, 'side')).key)).toBeCloseTo(10 * (Math.PI / 2) * 4, 6);

    const wider = ring((x) => [angle(x, '120 deg')]);
    const turned = build(wider);
    expect(area(turned, found(turned, wider, wall))).toBeCloseTo(10 * ((2 * Math.PI) / 3) * 4, 6);
    const c = centroid(turned, found(turned, wider, end));
    const a = (120 * Math.PI) / 180;
    expect(c).toEqual([
      expect.closeTo(7.5 * Math.cos(a), 9),
      expect.closeTo(7.5 * Math.sin(a), 9),
      expect.closeTo(-2, 9),
    ]);

    const moved = ring((x) => [angle(x, '90 deg')], 7, 12);
    const shifted = build(moved);
    expect(area(shifted, found(shifted, moved, wall))).toBeCloseTo(12 * (Math.PI / 2) * 4, 6);
    expect(centroid(shifted, found(shifted, moved, end))[1]).toBeCloseTo(9.5, 9);
  });

  it('follows a changed dimension through the sketch solve, keeping a pick on the outer wall', () => {
    const dimensioned = (gap: string) => {
      const d = new DocBuilder();
      let axis = '';
      const s = d.sketch('xz', (x) => {
        const [a, b] = [x.point(0, 0), x.point(0, 10)];
        axis = x.line(a, b);
        construction(d, x);
        x.fixed(a);
        x.fixed(b);
        // Drawn roughly; the constraints and dimensions decide.
        const r = x.rect(4, 1, 4, 3);
        x.horizontal(r.lines[0] as string);
        x.vertical(r.lines[1] as string);
        x.horizontal(r.lines[2] as string);
        x.vertical(r.lines[3] as string);
        x.distanceX(a, r.points[0] as string, gap);
        x.distanceY(a, r.points[0] as string, '0 mm');
        x.distanceX(r.points[0] as string, r.points[1] as string, '5 mm');
        x.distanceY(r.points[0] as string, r.points[3] as string, '4 mm');
      });
      revolve(d, { profiles: [s.region([5, 2])], axis: along(d, curveRef(d, s.feature, axis)) });
      return d;
    };
    const d1 = dimensioned('5 mm');
    const before = build(d1, true);
    const outer = largest(before, facesOf(before, d1, 'side'));
    expect(area(before, outer.key)).toBeCloseTo(10 * (Math.PI / 2) * 4, 5);
    const record = pick(before, d1, outer);

    const d2 = dimensioned('8 mm');
    const after = build(d2, true);
    expect(area(after, found(after, d2, record))).toBeCloseTo(13 * (Math.PI / 2) * 4, 5);
    expect(volume(after, bodies(after, d2)[0] as NamedEntity)).toBeCloseTo(ringVolume(90, 8, 13), 5);
  });

  it('keeps a pick on a joined wall when a feature is added earlier', () => {
    const d = new DocBuilder();
    const early = d.sketch('xy', (x) => x.rect(-20, -20, 8, 8));
    d.extrude({ sketch: early.feature, profiles: [early.region([-19, -19])], sides: [{ distance: '2 mm' }] });
    const base = d.sketch('xy', (x) => x.rect(0, -20, 20, 40));
    d.extrude({ sketch: base.feature, profiles: [base.region([1, 0])], sides: [{ distance: '5 mm' }], op: 'join' });
    const s = d.sketch('xz', (y) => y.rect(5, -9, 5, 4));
    revolve(d, { profiles: [s.region([6, -6])], op: 'join' });

    const full = d.document();
    const without = structuredClone(full);
    (((without.parts as Json[])[0] as Json).timeline as Json[]).splice(0, 2);

    const before = evaluate(without, false);
    expect(before.pauses).toEqual([]);
    const outer = largest(
      before,
      facesOf(before, d, 'side').filter((e) => Math.abs(centroid(before, e.key)[2] - 7) < 1e-6),
    );
    const record = pick(before, d, outer);
    const was = centroid(before, outer.key);

    const after = evaluate(full, false);
    expect(after.pauses).toEqual([]);
    const now = centroid(after, found(after, d, record));
    now.forEach((x, i) => expect(x).toBeCloseTo(was[i] as number, 9));
  });

  describe('a full turn', () => {
    const full = () => [{ full: {} }];
    /** The areas of the walls of a ring from `inner` to `outer`, `height` tall, smallest first. */
    const ringWalls = (inner: number, outer: number, height: number) =>
      [
        2 * Math.PI * inner * height,
        2 * Math.PI * outer * height,
        Math.PI * (outer * outer - inner * inner),
        Math.PI * (outer * outer - inner * inner),
      ].sort((a, b) => a - b);
    const wallAreas = (ev: Evaluation, d: DocBuilder) =>
      facesOf(ev, d, 'side')
        .map((e) => area(ev, e.key))
        .sort((a, b) => a - b);
    const expectAreas = (now: number[], want: number[]) => {
      expect(now).toHaveLength(want.length);
      now.forEach((x, i) => expect(x).toBeCloseTo(want[i] as number, 5));
    };

    it('names every wall after its curve, with no caps', () => {
      const d = ring(full);
      const ev = build(d);
      expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(ringVolume(360), 6);
      expect(all(ev, d).filter((e) => e.kind === 'face')).toHaveLength(4);
      expectAreas(wallAreas(ev, d), ringWalls(5, 10, 4));
      expect(new Set(facesOf(ev, d, 'side').map((e) => e.ladder.join('/'))).size).toBe(4);
      expect(facesOf(ev, d, 'start')).toEqual([]);
      expect(facesOf(ev, d, 'end')).toEqual([]);
    });

    it('turns the same way about a reversed axis', () => {
      const d = new DocBuilder();
      const s = ringSketch(d);
      revolve(d, { profiles: [s.region([6, 1])], sides: full(), axis: standardZ(d, true) });
      const ev = build(d);
      expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(ringVolume(360), 6);
      expectAreas(wallAreas(ev, d), ringWalls(5, 10, 4));
    });

    it('keeps a pick on each wall when the profile changes', () => {
      const d1 = ring(full);
      const before = build(d1);
      const walls = [...facesOf(before, d1, 'side')].sort((a, b) => area(before, a.key) - area(before, b.key));
      const [inner, flat, flat2, outer] = walls as [NamedEntity, NamedEntity, NamedEntity, NamedEntity];
      const [topZ, bottomZ] = [flat, flat2].map((e) => centroid(before, e.key)[2]) as [number, number];
      const records = walls.map((w) => pick(before, d1, w));

      const d2 = ring(full, 7, 12, 6);
      const after = build(d2);
      const moved = records.map((r) => found(after, d2, r));
      expect(area(after, moved[0] as ShapeKey)).toBeCloseTo(2 * Math.PI * 7 * 6, 5);
      expect(area(after, moved[3] as ShapeKey)).toBeCloseTo(2 * Math.PI * 12 * 6, 5);
      expect(area(after, moved[1] as ShapeKey)).toBeCloseTo(Math.PI * (144 - 49), 5);
      expect(area(after, moved[2] as ShapeKey)).toBeCloseTo(Math.PI * (144 - 49), 5);
      expect(Math.sign(centroid(after, moved[1] as ShapeKey)[2] - centroid(after, moved[2] as ShapeKey)[2])).toBe(
        Math.sign(topZ - bottomZ),
      );
      expect(inner.key).not.toBe(outer.key);
    });

    it('gives the same names when the document builds again', () => {
      const names = (ev: Evaluation, d: DocBuilder) =>
        facesOf(ev, d, 'side')
          .map((e) => e.ladder.join('/'))
          .sort();
      const d = ring(full);
      expect(names(build(d), d)).toEqual(names(build(d), d));
    });

    it('follows a changed dimension through the sketch solve', () => {
      const dimensioned = (gap: string) => {
        const d = new DocBuilder();
        let axis = '';
        const s = d.sketch('xz', (x) => {
          const [a, b] = [x.point(0, 0), x.point(0, 10)];
          axis = x.line(a, b);
          construction(d, x);
          x.fixed(a);
          x.fixed(b);
          const r = x.rect(4, 1, 4, 3);
          x.horizontal(r.lines[0] as string);
          x.vertical(r.lines[1] as string);
          x.horizontal(r.lines[2] as string);
          x.vertical(r.lines[3] as string);
          x.distanceX(a, r.points[0] as string, gap);
          x.distanceY(a, r.points[0] as string, '0 mm');
          x.distanceX(r.points[0] as string, r.points[1] as string, '5 mm');
          x.distanceY(r.points[0] as string, r.points[3] as string, '4 mm');
        });
        revolve(d, { profiles: [s.region([5, 2])], sides: full(), axis: along(d, curveRef(d, s.feature, axis)) });
        return d;
      };
      const d1 = dimensioned('5 mm');
      const before = build(d1, true);
      const outer = largest(before, facesOf(before, d1, 'side'));
      expect(area(before, outer.key)).toBeCloseTo(2 * Math.PI * 10 * 4, 5);
      const record = pick(before, d1, outer);

      const d2 = dimensioned('8 mm');
      const after = build(d2, true);
      expect(area(after, found(after, d2, record))).toBeCloseTo(2 * Math.PI * 13 * 4, 5);
      expect(volume(after, bodies(after, d2)[0] as NamedEntity)).toBeCloseTo(ringVolume(360, 8, 13), 5);
    });

    it('makes no wall of an edge on the axis', () => {
      for (const reversed of [false, true]) {
        const d = ring(full, 0, 10, 4, reversed);
        const ev = build(d);
        expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(ringVolume(360, 0), 6);
        expectAreas(wallAreas(ev, d), [2 * Math.PI * 10 * 4, Math.PI * 100, Math.PI * 100]);
      }
    });

    it('turns a disc into a torus and a half disc into a sphere', () => {
      const disc = new DocBuilder();
      const s = disc.sketch('xz', (x) => x.circle(10, 0, 2));
      revolve(disc, { profiles: [s.region([10, 0])], sides: full() });
      const torus = build(disc);
      expect(volume(torus, bodies(torus, disc)[0] as NamedEntity)).toBeCloseTo(Math.PI * 4 * 2 * Math.PI * 10, 6);
      expect(facesOf(torus, disc, 'side')).toHaveLength(1);

      const ball = new DocBuilder();
      const t = ball.sketch('xz', (x) => {
        x.circle(0, 0, 5);
        const [a, b] = [x.point(0, -6), x.point(0, 6)];
        x.line(a, b);
      });
      revolve(ball, { profiles: [t.region([1, 0])], sides: full() });
      const sphere = build(ball);
      expect(volume(sphere, bodies(sphere, ball)[0] as NamedEntity)).toBeCloseTo((4 / 3) * Math.PI * 125, 5);
      expect(facesOf(sphere, ball, 'side')).toHaveLength(1);
    });

    it('turns each of several profiles', () => {
      const d = new DocBuilder();
      const s = d.sketch('xz', (x) => {
        x.rect(5, 0, 2, 4);
        x.rect(10, 0, 2, 4);
      });
      revolve(d, { profiles: [s.region([6, 1]), s.region([11, 1])], sides: full() });
      const ev = build(d);
      expect(bodies(ev, d)).toHaveLength(2);
      expect(facesOf(ev, d, 'side')).toHaveLength(8);
    });

    it('joins onto a plate and cuts a groove into it', () => {
      const joined = plate((x) => {
        const s = x.sketch('xz', (y) => y.rect(5, -9, 5, 4));
        revolve(x, { profiles: [s.region([6, -7])], sides: full(), op: 'join' });
      });
      const ev = build(joined);
      expect(bodies(ev, joined)).toHaveLength(1);
      // The ring stands on the plate, from z = 5 to 9.
      expect(volume(ev, bodies(ev, joined)[0] as NamedEntity)).toBeCloseTo(40 * 40 * 5 + ringVolume(360), 5);
      expect(facesOf(ev, joined, 'side').filter((e) => centroid(ev, e.key)[2] > 5 + 1e-6)).toHaveLength(3);

      const cut = plate((x) => {
        const s = x.sketch('xz', (y) => y.rect(5, -7, 5, 4));
        revolve(x, { profiles: [s.region([6, -4])], sides: full(), op: 'cut' });
      });
      const ev2 = build(cut);
      // The tool runs from z = 3 to 7; the plate ends at 5.
      expect(volume(ev2, bodies(ev2, cut)[0] as NamedEntity)).toBeCloseTo(40 * 40 * 5 - ringVolume(360, 5, 10, 2), 5);
    });

    it('keeps a pick on a wall that a later feature joins onto', () => {
      const edited = (extra: boolean) => {
        const d = ring(full);
        if (extra) {
          const s = d.sketch('xy', (x) => x.rect(20, 20, 5, 5));
          d.extrude({ sketch: s.feature, profiles: [s.region([21, 21])], sides: [{ distance: '5 mm' }] });
        }
        return d;
      };
      const d1 = edited(false);
      const before = build(d1);
      const record = pick(before, d1, largest(before, facesOf(before, d1, 'side')));
      const d2 = edited(true);
      const after = build(d2);
      expect(area(after, found(after, d2, record))).toBeCloseTo(2 * Math.PI * 10 * 4, 5);
    });

    it('refuses a second side', () => {
      const d = ring((x) => [{ full: {} }, angle(x, '10 deg')]);
      expect(pauseOf(d)).toBe('a full revolve is the only side');
    });
  });

  it('pauses a partial revolve of a whole turn or more, which the kernel would close or wrap', () => {
    expect(pauseOf(ring((x) => [angle(x, '360 deg')]))).toBe('a partial revolve turns by less than a full turn');
    expect(pauseOf(ring((x) => [angle(x, '400 deg')]))).toBe('a partial revolve turns by less than a full turn');
    expect(pauseOf(ring((x) => [angle(x, '200 deg'), angle(x, '160 deg')]))).toBe(
      'a partial revolve turns by less than a full turn',
    );
  });

  it('pauses angles that turn nowhere or backwards', () => {
    expect(pauseOf(ring((x) => [angle(x, '0 deg')]))).toBe('the revolve turns by no angle');
    expect(pauseOf(ring((x) => [angle(x, '90 deg'), angle(x, '-30 deg')]))).toBe(
      'a revolve side turns by a negative angle',
    );
  });

  it('pauses an axis that crosses the profile, through edges or only through corners', () => {
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => x.rect(-3, 0, 13, 4));
    revolve(d, { profiles: [s.region([1, 1])] });
    expect(pauseOf(d)).toBe('the axis crosses the profile');

    const diamond = new DocBuilder();
    const t = diamond.sketch('xz', (x) => {
      const p = [x.point(0, -5), x.point(5, 0), x.point(0, 5), x.point(-5, 0)];
      p.forEach((q, i) => x.line(q, p[(i + 1) % 4] as string));
    });
    revolve(diamond, { profiles: [t.region([1, 0])] });
    expect(pauseOf(diamond)).toBe('the axis crosses the profile');
  });

  it('pauses an axis outside the plane of the profile', () => {
    const d = new DocBuilder();
    const s = ringSketch(d);
    revolve(d, { profiles: [s.region([6, 1])], axis: through(d, 0, 0, 0, 'y') });
    expect(pauseOf(d)).toBe('only an axis in the plane of the profile is built yet');

    const off = new DocBuilder();
    const t = ringSketch(off);
    revolve(off, { profiles: [t.region([6, 1])], axis: through(off, 0, 3, 0, 'z') });
    expect(pauseOf(off)).toBe('only an axis in the plane of the profile is built yet');
  });

  it('pauses an axis that is no line', () => {
    const d = new DocBuilder();
    let circle = '';
    const s = d.sketch('xz', (x) => {
      x.rect(5, 0, 5, 4);
      circle = x.circle(-10, 0, 1);
    });
    revolve(d, { profiles: [s.region([6, 1])], axis: along(d, curveRef(d, s.feature, circle)) });
    expect(pauseOf(d)).toBe('the axis names no line in this build');
  });

  it('refuses a revolve with three sides', () => {
    const d = ring((x) => [angle(x, '10 deg'), angle(x, '10 deg'), angle(x, '10 deg')]);
    const read = readDocument(JSON.parse(JSON.stringify(d.document())));
    expect(read.diagnostics.map((x) => x.message)).toContain('a revolve has one or two sides');
  });
});
