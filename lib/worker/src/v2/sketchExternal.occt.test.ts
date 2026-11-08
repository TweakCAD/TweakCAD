/**
 * External sketch curves on the real kernel: model edges projected into a
 * sketch, faces cut by its plane and silhouettes, held fixed in the solve so
 * dimensions to them follow the model, bounding regions when defining, and
 * pausing when their source is gone or yields other curves.
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
  prepareCurve,
  readDocument,
  resolve,
  writeRecord,
  type CurveShape,
  type EntityRecord,
  type NamedEntity,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder, type SketchDraw } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
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

function evaluate(doc: Json): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k, { solver: gcs });
  builds.push(ev);
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = evaluate(d.document());
  expect(ev.pauses).toEqual([]);
  return ev;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const entities = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const near = (a: readonly number[], b: readonly number[], tol = 1e-6) =>
  a.every((x, i) => Math.abs(x - (b[i] as number)) <= tol);

/** The entity of `kind` whose midpoint (edges) or centroid (faces) is `at`. */
function entityAt(ev: Evaluation, d: DocBuilder, kind: 'edge' | 'face', at: Vec3): NamedEntity {
  const found = entities(ev, d).filter((e) => {
    if (e.kind !== kind) return false;
    const m = ev.adapter.measures(e.key);
    return near((kind === 'edge' ? m.midpoint : m.centroid) as Vec3, at);
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Picks an entity on a build of `prefix` as the editor would, its names carried into later documents. */
function pick(prefix: () => DocBuilder, kind: 'edge' | 'face', at: Vec3): { record: EntityRecord; names: Json } {
  const d = prefix();
  const ev = build(d);
  const record = writeRecord(entityAt(ev, d, kind, at), stateOf(ev, d), ev.adapter);
  return { record, names: ev.names.toJson() as Json };
}

function carry(d: DocBuilder, picked: { names: Json }): void {
  for (const name of Object.values(picked.names)) d.names.intern(name as never);
}

/** A plate `width` wide, 30 deep and 5 thick, its width a dimension. */
function plate(width: number): DocBuilder {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => {
    const r = x.rect(0, 0, 50, 30);
    x.fixed(r.points[0] as string);
    x.horizontal(r.lines[0] as string);
    x.vertical(r.lines[1] as string);
    x.horizontal(r.lines[2] as string);
    x.vertical(r.lines[3] as string);
    x.distanceX(r.points[0] as string, r.points[1] as string, `${width} mm`);
    x.distanceY(r.points[0] as string, r.points[3] as string, '30 mm');
  });
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
  return d;
}

const WIDTH = 50;
/** The plate's right edge along its top. */
const rightEdge = () => pick(() => plate(WIDTH), 'edge', [WIDTH, 15, 5]);

/** A distance from a point to an external curve. */
function distanceTo(d: DocBuilder, s: SketchDraw, p: string, external: string, value: string): void {
  s.constraint('distance', {
    a: { point: { id: p } },
    b: { external: { id: external } },
    value: d.val(value),
    solved: 0,
    label: { auto: {} },
  });
}

/**
 * The plate with a boss on top, 4 mm in from the plate's right edge: the
 * boss sketch projects that edge and dimensions its rectangle to it.
 */
function bossed(
  width: number,
  edge: { record: EntityRecord; names: Json },
): { d: DocBuilder; sketch: string; corner: string } {
  const d = plate(width);
  carry(d, edge);
  let corner = '';
  const s = d.sketch(
    'xy',
    (x) => {
      const ext = x.external({ entity: edge.record }, {});
      const origin = x.point(0, 0);
      x.fixed(origin);
      const r = x.rect(36, 5, 6, 20);
      corner = r.points[1] as string;
      x.horizontal(r.lines[0] as string);
      x.vertical(r.lines[1] as string);
      x.horizontal(r.lines[2] as string);
      x.vertical(r.lines[3] as string);
      x.distanceX(r.points[0] as string, r.points[1] as string, '6 mm');
      x.distanceY(r.points[1] as string, r.points[2] as string, '20 mm');
      x.distanceY(origin, r.points[0] as string, '5 mm');
      distanceTo(d, x, corner, ext, '4 mm');
    },
    5,
  );
  d.extrude({ sketch: s.feature, profiles: [s.region([37, 6])], sides: [{ distance: '3 mm' }], op: 'join' });
  return { d, sketch: s.feature, corner };
}

describe('projected model edges', () => {
  it('holds a dimension to a projected edge, which follows the model, and keeps picks on the boss', () => {
    const edge = rightEdge();
    const a = bossed(WIDTH, edge);
    const evA = build(a.d);
    const at = (ev: Evaluation, b: typeof a) =>
      ev.parts
        .get(b.d.partId)!
        .sketches.get(b.sketch)!
        .solved.points.find((p) => p.id === b.corner)!;
    expect(at(evA, a).x).toBeCloseTo(WIDTH - 4, 9);
    // The projected edge is a line of the sketch, from its smaller end.
    const lines = [...evA.parts.get(a.d.partId)!.sketches.get(a.sketch)!.lines.values()].filter((l) =>
      near(l[0]![0], [WIDTH, 0]),
    );
    expect(lines).toHaveLength(1);
    expect(near(lines[0]![0]![1], [WIDTH, 30])).toBe(true);

    const side = entityAt(evA, a.d, 'face', [WIDTH - 4, 15, 6.5]);
    const top = entityAt(evA, a.d, 'face', [WIDTH - 7, 15, 8]);
    const records = [side, top].map((e) => writeRecord(e, stateOf(evA, a.d), evA.adapter));

    const b = bossed(70, edge);
    const evB = build(b.d);
    expect(at(evB, b).x).toBeCloseTo(66, 9);
    const expected: Vec3[] = [
      [66, 15, 6.5],
      [63, 15, 8],
    ];
    records.forEach((record, i) => {
      const found = resolve(record, stateOf(evB, b.d), evB.adapter);
      expect(found.outcome).toBe('same');
      if (found.outcome !== 'same') return;
      expect(found.entities).toHaveLength(1);
      expect(near(evB.adapter.measures(found.entities[0]!.key).centroid as Vec3, expected[i]!)).toBe(true);
    });
  });

  it('pauses the sketch, naming the row, when the projected edge is gone, and what is built on it', () => {
    const edge = rightEdge();
    const { d, sketch } = bossed(WIDTH, edge);
    const doc = d.document();
    const timeline = ((doc.parts as Json[])[0] as Json).timeline as Json[];
    // Suppressing the plate's extrude takes the edge away.
    (((timeline[1] as Json).suppressed as Json).def as Json).expr = { text: 'true', grammar: 1, refs: {} };
    const ev = evaluate(doc);
    expect(ev.pauses.map((p) => p.feature)).toEqual([sketch, timeline[3]!.id]);
    expect(ev.pauses[0]!.message).toMatch(/^external curve crv_\w+: the source is gone/);
  });

  /** A pocket bounded by the projected edge itself: a defining external curve closes a U of drawn lines. */
  function notched(width: number, edge: { record: EntityRecord; names: Json }): { d: DocBuilder; ext: string } {
    const d = plate(width);
    carry(d, edge);
    let ext = '';
    const s = d.sketch(
      'xy',
      (x) => {
        ext = x.external(
          { entity: edge.record },
          { defining: true, shape: { kind: 'line', start: [width, 0], end: [width, 30] } },
        );
        const origin = x.point(0, 0);
        x.fixed(origin);
        const [a, b, c, e] = [x.point(width, 5), x.point(width - 8, 5), x.point(width - 8, 25), x.point(width, 25)];
        x.line(a, b);
        x.line(b, c);
        x.line(c, e);
        for (const p of [a, e])
          x.constraint('pointOnCurve', { point: { point: { id: p } }, curve: { external: { id: ext } } });
        x.constraint('horizontal', { of: { points: { a: { point: { id: a } }, b: { point: { id: b } } } } });
        x.constraint('horizontal', { of: { points: { a: { point: { id: e } }, b: { point: { id: c } } } } });
        x.constraint('vertical', { of: { points: { a: { point: { id: b } }, b: { point: { id: c } } } } });
        distanceTo(d, x, b, ext, '8 mm');
        x.distanceY(origin, a, '5 mm');
        x.distanceY(a, e, '20 mm');
      },
      5,
    );
    // A body of its own, so its wall on the projected edge does not merge into the plate's end face.
    d.extrude({ sketch: s.feature, profiles: [s.region([width - 4, 15])], sides: [{ distance: '2 mm' }] });
    return { d, ext };
  }

  it('bounds a region with a defining projected edge, names the wall on it after the row, and keeps a pick on that wall', () => {
    const edge = rightEdge();
    const a = notched(WIDTH, edge);
    const evA = build(a.d);
    const wallsOf = (ev: Evaluation, b: typeof a) =>
      entities(ev, b.d).filter((e) => {
        const level = ev.names.get(e.ladder.at(-1) as string) as
          { role?: string; src?: { id?: { id: string } }[] } | undefined;
        return e.kind === 'face' && level?.role === 'side' && level.src?.[0]?.id?.id === b.ext;
      });
    const [wall] = wallsOf(evA, a);
    expect(wallsOf(evA, a)).toHaveLength(1);
    expect(near(evA.adapter.measures(wall!.key).centroid as Vec3, [WIDTH, 15, 6])).toBe(true);
    const record = writeRecord(wall!, stateOf(evA, a.d), evA.adapter);
    const b = notched(62, edge);
    const evB = build(b.d);
    const found = resolve(record, stateOf(evB, b.d), evB.adapter);
    expect(found.outcome).toBe('same');
    if (found.outcome === 'same')
      expect(near(evB.adapter.measures(found.entities[0]!.key).centroid as Vec3, [62, 15, 6])).toBe(true);
  });
});

describe('references to external curves', () => {
  it('revolves a profile about a projected edge, named as a sketch curve (9.4 `curve`)', () => {
    const edge = rightEdge();
    for (const width of [WIDTH, 64]) {
      const d = plate(width);
      carry(d, edge);
      let ext = '';
      const s = d.sketch(
        'xy',
        (x) => {
          ext = x.external({ entity: edge.record }, {});
          x.rect(width + 2, 10, 4, 10);
        },
        5,
      );
      const axis = ladderOf(
        { kind: 'curve', chain: [], feature: s.feature, role: 'curve', src: [idItem(ext)] },
        d.names,
      );
      d.feature('core.revolve', {
        profiles: makeSet([s.region([width + 3, 11])]),
        axis: {
          along: {
            ref: { entity: { id: axis, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } },
            reversed: d.val('false'),
          },
        },
        sides: [{ angle: { a: d.val('90 deg') } }],
        thin: { solid: {} },
        operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
      });
      const ev = build(d);
      // A quarter of a ring about the line x = width, z = 5, from radius 2 to 6 and 10 long.
      const bodies = [...ev.parts.get(d.partId)!.shapes.values()];
      expect(bodies).toHaveLength(2);
      const volume = k.getVolume(bodies[1]!);
      expect(volume).toBeCloseTo((Math.PI / 4) * (36 - 4) * 10, 6);
      const box = k.getBoundingBox(bodies[1]!);
      expect(box.xmin).toBeCloseTo(width, 6);
    }
  });
});

/** A cylinder of radius 5 standing on the xy plane at (cx, 0), 20 tall. */
function cylinder(cx: number): DocBuilder {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.circle(cx, 0, 5));
  d.extrude({ sketch: s.feature, profiles: [s.region([cx, 0])], sides: [{ distance: '20 mm' }] });
  return d;
}

describe('intersections and silhouettes', () => {
  const wall = () => pick(() => cylinder(0), 'face', [0, 0, 10]);

  function cut(
    cx: number,
    picked: { record: EntityRecord; names: Json },
    count: number,
  ): { d: DocBuilder; sketch: string; center: string } {
    const d = cylinder(cx);
    carry(d, picked);
    let center = '';
    const s = d.sketch(
      'xy',
      (x) => {
        const ext = x.external({ entity: picked.record }, { mode: 'intersect', index: 0, count, near: [5, 0] });
        const c = x.circle(1, 1, 2);
        center = (x.curves.find((r) => r.id === c) as Json).center as string;
        x.constraint('concentric', { a: { curve: { id: c } }, b: { external: { id: ext } } });
      },
      10,
    );
    return { d, sketch: s.feature, center };
  }

  it('cuts a face with the sketch plane and holds a circle concentric with the cut', () => {
    const picked = wall();
    for (const cx of [0, 3]) {
      const { d, sketch, center } = cut(cx, picked, 1);
      const ev = build(d);
      const p = ev.parts
        .get(d.partId)!
        .sketches.get(sketch)!
        .solved.points.find((q) => q.id === center)!;
      expect(near([p.x, p.y], [cx, 0], 1e-9)).toBe(true);
    }
  });

  it('pauses an intersection that now yields another number of curves than its row recorded', () => {
    const { d, sketch } = cut(0, wall(), 2);
    const ev = evaluate(d.document());
    expect(ev.pauses.map((p) => p.feature)).toEqual([sketch]);
    expect(ev.pauses[0]!.message).toMatch(/yields 1 curves, not 2/);
  });

  /** A cylinder of radius 4 lying along x at y = 2 and height 6, seen from above. */
  function lying(): DocBuilder {
    const d = new DocBuilder();
    // On the YZ plane sketch x is world −Z and sketch y is world Y.
    const s = d.sketch('yz', (x) => x.circle(-6, 2, 4));
    d.extrude({ sketch: s.feature, profiles: [s.region([-6, 2])], sides: [{ distance: '15 mm' }] });
    return d;
  }

  it('takes the silhouette of a lying cylinder: its two outermost generators, by index', () => {
    const picked = pick(lying, 'face', [7.5, 2, 6]);
    const d = lying();
    carry(d, picked);
    const exts: string[] = [];
    const s = d.sketch('xy', (x) => {
      // Sorted by start point: the generator at y = −2, then the one at y = 6.
      exts.push(x.external({ entity: picked.record }, { mode: 'silhouette', index: 0, count: 2, near: [0, -2] }));
      exts.push(x.external({ entity: picked.record }, { mode: 'silhouette', index: 1, count: 2, near: [0, 6] }));
    });
    const ev = build(d);
    const lines = ev.parts.get(d.partId)!.sketches.get(s.feature)!.lines;
    expect(near(lines.get(exts[0]!)![0]!.flat(), [0, -2, 15, -2], 1e-9)).toBe(true);
    expect(near(lines.get(exts[1]!)![0]!.flat(), [0, 6, 15, 6], 1e-9)).toBe(true);
  });

  it('pauses a silhouette row whose curve no longer starts nearest its recorded point', () => {
    const picked = pick(lying, 'face', [7.5, 2, 6]);
    const d = lying();
    carry(d, picked);
    const s = d.sketch('xy', (x) => {
      x.external({ entity: picked.record }, { mode: 'silhouette', index: 0, count: 2, near: [0, 6] });
    });
    const ev = evaluate(d.document());
    expect(ev.pauses.map((p) => p.feature)).toEqual([s.feature]);
    expect(ev.pauses[0]!.message).toMatch(/changed order/);
  });
});

describe('exact projections onto a tilted plane', () => {
  const TILT = 30;

  /** A disc and a spline-topped block, 4 thick. */
  function base(): DocBuilder {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.circle(0, 0, 6);
      const through = [x.point(10, 0), x.point(14, 5), x.point(18, 2), x.point(22, 6)];
      x.curve('spline', { through });
      const [right, left] = [x.point(22, -4), x.point(10, -4)];
      x.line(through[3] as string, right);
      x.line(right, left);
      x.line(left, through[0] as string);
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([0, 0]), s.region([16, 0])], sides: [{ distance: '4 mm' }] });
    return d;
  }

  it('projects a circle to the ellipse it is seen as, and a spline to the B-spline over its projected poles', () => {
    const d0 = base();
    const ev0 = build(d0);
    const m = (e: NamedEntity) => ev0.adapter.measures(e.key);
    const edges = entities(ev0, d0).filter((e) => e.kind === 'edge');
    const onTop = (e: NamedEntity) => Math.abs(m(e).bbox![0][2] - 4) < 1e-6;
    const topCircle = edges.find((e) => m(e).curve === 'circle' && onTop(e))!;
    const topSpline = edges.find((e) => m(e).curve === 'freeform' && onTop(e))!;
    const records = [topCircle, topSpline].map((e) => writeRecord(e, stateOf(ev0, d0), ev0.adapter));

    const d = base();
    for (const name of Object.values(ev0.names.toJson() as Json)) d.names.intern(name as never);
    const ids: string[] = [];
    const sketch = d.sketch('xy', (x) => {
      for (const record of records) ids.push(x.external({ entity: record }, { defining: true }));
    }).feature;
    // Tilt the sketch plane about x.
    const doc = d.document();
    const row = (((doc.parts as Json[])[0] as Json).timeline as Json[]).find((f) => f.id === sketch) as Json;
    const attach = ((row.inputs as Json).frame as Json).attach as Json;
    const tilt = `placement(vector(0 mm, 0 mm, 40 mm), rotate(vector(1, 0, 0), ${TILT} deg))`;
    ((attach.offset as Json).def as Json).expr = { text: tilt, grammar: 1, refs: {} };
    const ev = evaluate(doc);
    expect(ev.pauses).toEqual([]);

    const built = ev.parts.get(d.partId)!.sketches.get(sketch)!;
    const shapeOf = (id: string): CurveShape =>
      built.solved.curves.find((c) => 'drawn' in c.key && c.key.drawn.id === id)!.shape;
    const { frame } = built;
    const to = (p: Vec3): [number, number] => {
      const q: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
      return [
        q[0] * frame.x[0] + q[1] * frame.x[1] + q[2] * frame.x[2],
        q[0] * frame.y[0] + q[1] * frame.y[1] + q[2] * frame.y[2],
      ];
    };
    const ellipse = shapeOf(ids[0]!);
    expect(ellipse.kind).toBe('ellipse');
    if (ellipse.kind !== 'ellipse') return;
    const c = to([0, 0, 4]);
    expect(near(ellipse.center, c, 1e-9)).toBe(true);
    expect(Math.hypot(ellipse.majorEnd[0] - c[0], ellipse.majorEnd[1] - c[1])).toBeCloseTo(6, 9);
    expect(ellipse.minorRadius).toBeCloseTo(6 * Math.cos((TILT * Math.PI) / 180), 9);

    // The projected B-spline passes through the projections of the edge's own points.
    const spline = shapeOf(ids[1]!);
    expect(spline.kind).toBe('nurbs');
    const curve = prepareCurve(spline, false)!;
    const handle = ev.adapter.handleOf(topSpline.key);
    const { first, last } = k.curveParameters(handle);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const p = k.curvePointAtParam(handle, first + (last - first) * f);
      expect(curve.closest(to([p.x, p.y, p.z]))[0]!.distance).toBeLessThan(1e-9);
    }
  });
});
