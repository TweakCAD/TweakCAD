/**
 * Extrude on the real kernel: several profiles, join and cut, both-sided and
 * symmetric extents, taper, and dimension edits through the sketch solve,
 * with picks that keep their face.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument, resolve, writeRecord, type NamedEntity, type ShapeKey, type Vec3 } from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { entityPrints, preciseBuild } from './boundsOracle';
import { primitive } from './primitivesDocs';

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

function build(d: DocBuilder, solve = false): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k, solve ? { solver: gcs } : {});
  builds.push(ev);
  // The reach of an extrude taken from loose boxes builds what precise boxes build.
  const precise = preciseBuild(doc, k, solve ? { solver: gcs } : {});
  builds.push(precise);
  expect(entityPrints(ev)).toEqual(entityPrints(precise));
  expect(ev.pauses).toEqual([]);
  return ev;
}

const all = (ev: Evaluation, d: DocBuilder) => [...(ev.parts.get(d.partId)?.state.entities.values() ?? [])];
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;

/** A 20 × 10 plate extruded `depth` from the XY plane, with whatever `more` adds. */
function plate(width = 20, depth = '5 mm', more?: (d: DocBuilder) => void): DocBuilder {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.rect(0, 0, width, 10));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: depth }] });
  more?.(d);
  return d;
}

describe('extrude', () => {
  it('makes one body per separate profile, each named after its own region', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 10, 10);
      x.rect(20, 0, 5, 5);
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1]), s.region([21, 1])], sides: [{ distance: '2 mm' }] });
    const ev = build(d);
    const found = bodies(ev, d).sort((a, b) => volume(ev, b) - volume(ev, a));
    expect(found).toHaveLength(2);
    expect(volume(ev, found[0] as NamedEntity)).toBeCloseTo(200, 6);
    expect(volume(ev, found[1] as NamedEntity)).toBeCloseTo(50, 6);
    expect(found[0]?.ladder).not.toEqual(found[1]?.ladder);
  });

  it('makes one body of profiles that touch, and one more of a profile apart from them', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 20, 10);
      // A line across the rectangle divides it into two regions that share an edge.
      x.line(x.point(10, -1), x.point(10, 11));
      x.rect(30, 0, 5, 5);
    });
    d.extrude({
      sketch: s.feature,
      profiles: [s.region([5, 5]), s.region([15, 5]), s.region([31, 1])],
      sides: [{ distance: '2 mm' }],
    });
    const ev = build(d);
    const found = bodies(ev, d).sort((a, b) => volume(ev, b) - volume(ev, a));
    expect(found).toHaveLength(2);
    expect(volume(ev, found[0] as NamedEntity)).toBeCloseTo(20 * 10 * 2, 6);
    expect(volume(ev, found[1] as NamedEntity)).toBeCloseTo(5 * 5 * 2, 6);
  });

  it('makes one body of a ring and the disc inside it picked together, and a holed body of the ring alone', () => {
    const ring = (withDisc: boolean) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => {
        x.rect(0, 0, 20, 20);
        x.circle(10, 10, 3);
      });
      d.extrude({
        sketch: s.feature,
        profiles: withDisc ? [s.region([1, 1]), s.region([10, 10])] : [s.region([1, 1])],
        sides: [{ distance: '2 mm' }],
      });
      return d;
    };
    const both = ring(true);
    const evBoth = build(both);
    expect(bodies(evBoth, both)).toHaveLength(1);
    expect(volume(evBoth, bodies(evBoth, both)[0] as NamedEntity)).toBeCloseTo(20 * 20 * 2, 6);
    const alone = ring(false);
    const evAlone = build(alone);
    expect(bodies(evAlone, alone)).toHaveLength(1);
    expect(volume(evAlone, bodies(evAlone, alone)[0] as NamedEntity)).toBeCloseTo((20 * 20 - Math.PI * 9) * 2, 3);
  });

  it('extrudes a half disc, whose chord midpoint is the centre of its arc', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      const a = x.point(-10, 0);
      const b = x.point(10, 0);
      const c = x.point(0, 0);
      x.line(a, b);
      x.curve('arc', { center: c, start: b, end: a });
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([0, 3])], sides: [{ distance: '2 mm' }] });
    const ev = build(d);
    const found = bodies(ev, d);
    expect(found).toHaveLength(1);
    expect(volume(ev, found[0] as NamedEntity)).toBeCloseTo((Math.PI * 100 * 2) / 2, 3);
  });

  it('joins a boss onto the plate, keeping the plate body', () => {
    const plain = build(plate());
    const d = plate(20, '5 mm', (x) => {
      const top = x.sketch('xy', (y) => y.rect(2, 2, 4, 4), 5);
      x.extrude({ sketch: top.feature, profiles: [top.region([3, 3])], sides: [{ distance: '3 mm' }], op: 'join' });
    });
    const ev = build(d);
    const [body] = bodies(ev, d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(volume(ev, body as NamedEntity)).toBeCloseTo(20 * 10 * 5 + 4 * 4 * 3, 6);
    expect(body?.ladder).toEqual(bodies(plain, plate())[0]?.ladder);
  });

  it('cuts a slot through all, and a pick on one piece stays on it when the plate widens', () => {
    const slotted = (width: number) =>
      plate(width, '5 mm', (x) => {
        const slot = x.sketch('xy', (y) => y.rect(9, -1, 2, 12));
        x.extrude({ sketch: slot.feature, profiles: [slot.region([10, 5])], sides: [{ throughAll: true }], op: 'cut' });
      });
    const d1 = slotted(20);
    const before = build(d1);
    const pieces = bodies(before, d1);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.ladder).toEqual(pieces[1]?.ladder);
    expect(pieces[0]?.branch).not.toEqual(pieces[1]?.branch);
    const leftTop = all(before, d1).find(
      (e) => e.kind === 'face' && roleOf(before, e) === 'end' && centroid(before, e.key)[0] < 9,
    ) as NamedEntity;
    const record = writeRecord(leftTop, before.parts.get(d1.partId)!.state, before.adapter);

    const d2 = slotted(30);
    const after = build(d2);
    const found = resolve(record, after.parts.get(d2.partId)!.state, after.adapter);
    expect(found.outcome).toBe('same');
    const key = found.outcome === 'same' ? (found.entities[0]?.key as ShapeKey) : -1;
    expect(centroid(after, key)[0]).toBeLessThan(9);
    expect(centroid(after, key)[2]).toBeCloseTo(5, 9);
  });

  it('builds the same through all whether its reach takes loose or precise boxes', { timeout: 60_000 }, () => {
    // A torus, whose loose box is wider than its precise one.
    const ring = () => {
      const d = new DocBuilder();
      primitive(d, 'torus', { majorRadius: '20 mm', minorRadius: '5 mm' });
      return d;
    };
    const d0 = ring();
    const base = build(d0);
    const handle = base.adapter.handleOf((bodies(base, d0)[0] as NamedEntity).key);
    expect(k.getBoundingBox(handle, { precise: false }).xmax - k.getBoundingBox(handle).xmax).toBeGreaterThan(1);
    // Each build is checked against the same build on precise boxes by `build`.
    for (const [sides, op] of [
      [[{ throughAll: true }], 'cut'],
      [[{ throughAll: true }], 'intersect'],
      [[{ throughAll: true }], 'join'],
      [[{ throughAll: true }], 'new'],
      [[{ throughAll: true }, { distance: '3 mm' }], 'cut'],
    ] as const) {
      const d = ring();
      const slot = d.sketch('xy', (y) => y.rect(18, -2, 4, 4), 30);
      d.extrude({
        sketch: slot.feature,
        profiles: [slot.region([20, 0])],
        sides: sides.map((x) => ({ ...x })),
        op,
        reversed: true,
      });
      expect(bodies(build(d), d).length).toBeGreaterThan(0);
    }
  });

  it('cuts through all from a profile far above the plate', () => {
    const d = plate(20, '5 mm', (x) => {
      const hole = x.sketch('xy', (y) => y.circle(10, 5, 1), 1000);
      x.extrude({
        sketch: hole.feature,
        profiles: [hole.region([10, 5])],
        sides: [{ throughAll: true }],
        op: 'cut',
        reversed: true,
      });
    });
    const ev = build(d);
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(20 * 10 * 5 - Math.PI * 5, 6);
  });

  it('extrudes a tiny profile alike wherever it lies in its sketch', () => {
    for (const x0 of [0, 10000]) {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.rect(x0, 0, 0.01, 0.01));
      d.extrude({ sketch: s.feature, profiles: [s.region([x0 + 0.005, 0.005])], sides: [{ distance: '1 mm' }] });
      const ev = build(d);
      expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(1e-4, 9);
      expect(all(ev, d).filter((e) => e.kind === 'face' && roleOf(ev, e) === 'side')).toHaveLength(4);
    }
  });

  it('extrudes both ways and symmetrically', () => {
    const twoSided = new DocBuilder();
    const s = twoSided.sketch('xy', (x) => x.rect(0, 0, 20, 10));
    twoSided.extrude({
      sketch: s.feature,
      profiles: [s.region([1, 1])],
      sides: [{ distance: '5 mm' }, { distance: '3 mm' }],
    });
    const ev = build(twoSided);
    expect(volume(ev, bodies(ev, twoSided)[0] as NamedEntity)).toBeCloseTo(20 * 10 * 8, 6);
    const z = all(ev, twoSided)
      .filter((e) => e.kind === 'face' && roleOf(ev, e) === 'start')
      .map((e) => centroid(ev, e.key)[2]);
    expect(z).toEqual([expect.closeTo(-3, 9)]);

    const sym = new DocBuilder();
    const t = sym.sketch('xy', (x) => x.rect(0, 0, 20, 10));
    sym.extrude({ sketch: t.feature, profiles: [t.region([1, 1])], symmetric: { d: '6 mm', measure: 'total' } });
    const ev2 = build(sym);
    expect(volume(ev2, bodies(ev2, sym)[0] as NamedEntity)).toBeCloseTo(20 * 10 * 6, 6);
  });

  it('widens with a positive taper and narrows with a negative one', () => {
    const tapered = (taper: string) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 10));
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm', taper }] });
      const ev = build(d);
      return { ev, d, v: volume(ev, bodies(ev, d)[0] as NamedEntity) };
    };
    const straight = 20 * 10 * 10;
    const out = tapered('5 deg');
    const into = tapered('-5 deg');
    expect(out.v).toBeGreaterThan(straight);
    expect(into.v).toBeLessThan(straight);
    // The walls keep their names through the draft.
    expect(all(out.ev, out.d).filter((e) => e.kind === 'face' && roleOf(out.ev, e) === 'side')).toHaveLength(4);
  });

  it('follows a changed dimension through the sketch solve, keeping a pick on the moved wall', () => {
    const dimensioned = (width: string) => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => {
        // Drawn roughly; the constraints and dimensions decide.
        const r = x.rect(0, 0, 18, 9);
        x.fixed(r.points[0] as string);
        x.horizontal(r.lines[0] as string);
        x.vertical(r.lines[1] as string);
        x.horizontal(r.lines[2] as string);
        x.vertical(r.lines[3] as string);
        x.distanceX(r.points[0] as string, r.points[1] as string, width);
        x.distanceY(r.points[0] as string, r.points[3] as string, '10 mm');
      });
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
      return d;
    };
    const d1 = dimensioned('20 mm');
    const before = build(d1, true);
    const right = all(before, d1).find(
      (e) => e.kind === 'face' && Math.abs(centroid(before, e.key)[0] - 20) < 1e-6,
    ) as NamedEntity;
    expect(right).toBeDefined();
    const record = writeRecord(right, before.parts.get(d1.partId)!.state, before.adapter);
    const d2 = dimensioned('35 mm');
    const after = build(d2, true);
    const found = resolve(record, after.parts.get(d2.partId)!.state, after.adapter);
    expect(found.outcome).toBe('same');
    const key = found.outcome === 'same' ? (found.entities[0]?.key as ShapeKey) : -1;
    expect(centroid(after, key)[0]).toBeCloseTo(35, 6);
  });
});

export type { Json };

describe('operations', () => {
  const identity = (e: NamedEntity) => JSON.stringify([e.ladder, e.branch]);
  const faceCount = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face').length;

  it('names each of three separate profiles after its own region', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 5, 5);
      x.rect(10, 0, 5, 5);
      x.rect(20, 0, 5, 5);
    });
    d.extrude({
      sketch: s.feature,
      profiles: [s.region([1, 1]), s.region([11, 1]), s.region([21, 1])],
      sides: [{ distance: '2 mm' }],
    });
    const ev = build(d);
    expect(new Set(bodies(ev, d).map(identity)).size).toBe(3);
  });

  it('leaves a body the join does not touch under its own name', () => {
    const withBystander = (boss: boolean) => {
      const d = plate();
      const far = d.sketch('xy', (x) => x.rect(40, 0, 5, 5));
      d.extrude({ sketch: far.feature, profiles: [far.region([41, 1])], sides: [{ distance: '5 mm' }] });
      if (boss) {
        const top = d.sketch('xy', (x) => x.rect(2, 2, 4, 4), 5);
        d.extrude({ sketch: top.feature, profiles: [top.region([3, 3])], sides: [{ distance: '3 mm' }], op: 'join' });
      }
      return d;
    };
    const d0 = withBystander(false);
    const ev0 = build(d0);
    const d1 = withBystander(true);
    const ev1 = build(d1);
    const bySize = (ev: Evaluation, d: DocBuilder) =>
      bodies(ev, d)
        .sort((a, b) => volume(ev, a) - volume(ev, b))
        .map(identity);
    expect(bySize(ev1, d1)).toEqual(bySize(ev0, d0));
    expect(new Set(bySize(ev1, d1)).size).toBe(2);
  });

  it('merges the faces a join leaves level with each other', () => {
    const d = plate(20, '5 mm', (x) => {
      const next = x.sketch('xy', (y) => y.rect(20, 0, 10, 10));
      x.extrude({ sketch: next.feature, profiles: [next.region([21, 1])], sides: [{ distance: '5 mm' }], op: 'join' });
    });
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(faceCount(ev, d)).toBe(6);
  });

  it('turns a negative second side back onto the first', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 10));
    d.extrude({
      sketch: s.feature,
      profiles: [s.region([1, 1])],
      sides: [{ distance: '10 mm' }, { distance: '-3 mm' }],
    });
    const ev = build(d);
    const body = bodies(ev, d)[0] as NamedEntity;
    expect(volume(ev, body)).toBeCloseTo(20 * 10 * 7, 6);
    const z = all(ev, d)
      .filter((e) => e.kind === 'face' && roleOf(ev, e) === 'start')
      .map((e) => centroid(ev, e.key)[2]);
    expect(z).toEqual([expect.closeTo(3, 9)]);
  });
});
