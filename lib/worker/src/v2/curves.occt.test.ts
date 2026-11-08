/**
 * Sketch curves past lines, arcs and circles on the real kernel: ellipses,
 * elliptical arcs, splines, beziers, conics and NURBS bound extruded
 * profiles exactly, each side face is named after its own curve, and a pick
 * on that face stays on it when the curve changes shape.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  prepareCurve,
  readDocument,
  resolve,
  writeRecord,
  type DetectedRegion,
  type Detection,
  type NamedEntity,
  type ShapeKey,
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

function evaluate(d: DocBuilder, solve: boolean): Evaluation {
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

const DEPTH = 4;
const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const entities = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const levelOf = (ev: Evaluation, e: NamedEntity) =>
  ev.names.get(e.ladder[1] as string) as { role?: string } | undefined;
const finest = (ev: Evaluation, e: NamedEntity) =>
  ev.names.get(e.ladder[e.ladder.length - 1] as string) as { src?: { id?: { id?: string } }[] } | undefined;
/** The side faces an extrude made from the curve `root`. */
const sidesOf = (ev: Evaluation, d: DocBuilder, root: string) =>
  entities(ev, d).filter(
    (e) => e.kind === 'face' && levelOf(ev, e)?.role === 'side' && finest(ev, e)?.src?.[0]?.id?.id === root,
  );
/** The area of the extruded profiles, as their start caps: the kernel measures planar faces closely, prisms of rational curves less so. */
const capArea = (ev: Evaluation, d: DocBuilder) =>
  entities(ev, d)
    .filter((e) => e.kind === 'face' && levelOf(ev, e)?.role === 'start')
    .reduce((s, e) => s + (ev.adapter.measures(e.key).area as number), 0);

/** A region's area by a fine polygon along its boundary: a reference for both the kernel and the format. */
function polygonArea(detection: Detection, region: DetectedRegion): number {
  let sum = 0;
  for (const cycle of [region.outer, ...region.inner]) {
    const points: (readonly [number, number])[] = [];
    for (const h of cycle.halfEdges) {
      const edge = detection.arrangement.edges[h >> 1]!;
      const live = detection.arrangement.curves[edge.curve]!;
      const [t0, t1] = (h & 1) === 0 ? [edge.t0, edge.t1] : [edge.t1, edge.t0];
      for (let i = 0; i < 20000; i++) points.push(live.curve.point(t0 + ((t1 - t0) * i) / 20000));
    }
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length]!;
      sum += (p[0] * q[1] - p[1] * q[0]) / 2;
    });
  }
  return sum;
}

/** A drawing of one curve kind, closed where needed by lines; `edit` changes its shape, never its rows. */
interface Case {
  name: string;
  draw: (d: DocBuilder, s: SketchDraw, edit: boolean) => string;
  /** Points inside the profiles to extrude. */
  inside: [number, number][];
}

const closeWith = (s: SketchDraw, a: string, b: string) => s.line(a, b);

const CASES: Case[] = [
  {
    name: 'an ellipse, turned off the axes',
    draw: (_d, s, edit) => {
      const center = s.point(0, 0);
      return s.curve('ellipse', { center, majorEnd: s.point(6, 2), minorRadius: edit ? 3.5 : 2.5 });
    },
    inside: [[0.5, 0.5]],
  },
  {
    name: 'an ellipse whose minor radius is the longer',
    draw: (_d, s, edit) =>
      s.curve('ellipse', { center: s.point(0, 0), majorEnd: s.point(edit ? 3 : 2, 0), minorRadius: 3 }),
    inside: [[0.5, 0.5]],
  },
  {
    name: 'an ellipse cut by a line, a stretch running over its start',
    draw: (_d, s, edit) => {
      const e = s.curve('ellipse', { center: s.point(0, 0), majorEnd: s.point(6, 0), minorRadius: edit ? 4 : 3 });
      s.line(s.point(2, -6), s.point(2, 6));
      return e;
    },
    inside: [
      [4, 0],
      [-1, 0],
    ],
  },
  {
    name: 'an elliptical arc closed by a line',
    draw: (_d, s, edit) => {
      const [start, end] = [s.point(0, edit ? -4 : -3), s.point(0, edit ? 4 : 3)];
      const arc = s.curve('ellipticalArc', {
        center: s.point(0, 0),
        majorEnd: s.point(6, 0),
        minorRadius: edit ? 4 : 3,
        start,
        end,
      });
      closeWith(s, end, start);
      return arc;
    },
    inside: [[1, 0]],
  },
  {
    name: 'a spline closed by a line',
    draw: (_d, s, edit) => {
      const through = [s.point(0, 0), s.point(3, 4), s.point(7, edit ? 7 : 5), s.point(10, 0)];
      const spline = s.curve('spline', { through });
      closeWith(s, through[3] as string, through[0] as string);
      return spline;
    },
    inside: [[5, 1]],
  },
  {
    name: 'a bezier closed by a line',
    draw: (_d, s, edit) => {
      const [a, b] = [s.point(0, 0), s.point(10, 0)];
      const bezier = s.curve('bezier', { start: a, c1: s.point(0, 6), c2: s.point(edit ? 14 : 10, 6), end: b });
      closeWith(s, b, a);
      return bezier;
    },
    inside: [[5, 1]],
  },
  {
    name: 'a conic closed by a line',
    draw: (d, s, edit) => {
      const [a, b] = [s.point(0, 0), s.point(10, 0)];
      const conic = s.curve('conic', { start: a, apex: s.point(5, 8), end: b, rho: d.val(edit ? '0.6' : '0.4') });
      closeWith(s, b, a);
      return conic;
    },
    inside: [[5, 1]],
  },
  {
    name: 'a rational NURBS closed by a line',
    draw: (d, s, edit) => {
      const poles = [s.point(0, 0), s.point(1, 5), s.point(5, 7), s.point(9, 4), s.point(10, 0)];
      const nurbs = s.curve('nurbs', {
        degree: d.val('3'),
        poles,
        weights: [1, edit ? 3 : 2, 1, 0.5, 1].map((w) => d.val(String(w))),
        knots: [0, 0.4, 1].map((u) => d.val(String(u))),
        multiplicities: [4, 1, 4],
        periodic: d.val('false'),
      });
      closeWith(s, poles[4] as string, poles[0] as string);
      return nurbs;
    },
    inside: [[5, 1]],
  },
  {
    name: 'an unclamped NURBS arch cut by a line',
    draw: (d, s, edit) => {
      const poles = [s.point(0, -4), s.point(1, 8), s.point(5, edit ? 12 : 10), s.point(9, 8), s.point(10, -4)];
      const nurbs = s.curve('nurbs', {
        degree: d.val('3'),
        poles,
        weights: poles.map(() => d.val('1')),
        knots: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((u) => d.val(String(u))),
        multiplicities: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        periodic: d.val('false'),
      });
      s.line(s.point(-2, 7), s.point(12, 7));
      return nurbs;
    },
    inside: [[5, 8]],
  },
  {
    name: 'a periodic NURBS cut by a line, a stretch running over its start',
    draw: (d, s, edit) => {
      const r = edit ? 12 : 10;
      const poles = Array.from({ length: 6 }, (_, i) =>
        s.point(r * Math.cos((i * Math.PI) / 3), r * Math.sin((i * Math.PI) / 3)),
      );
      const nurbs = s.curve('nurbs', {
        degree: d.val('3'),
        poles,
        weights: poles.map(() => d.val('1')),
        knots: [0, 1, 2, 3, 4, 5, 6].map((u) => d.val(String(u))),
        multiplicities: [1, 1, 1, 1, 1, 1, 1],
        periodic: d.val('true'),
      });
      s.line(s.point(1, -20), s.point(1, 20));
      return nurbs;
    },
    inside: [
      [4, 0],
      [-2, 0],
    ],
  },
];

function caseDoc(c: Case, edit: boolean): { d: DocBuilder; curve: string; sketch: SketchHandle } {
  const d = new DocBuilder();
  let curve = '';
  const sketch = d.sketch('xy', (s) => {
    curve = c.draw(d, s, edit);
  });
  d.extrude({
    sketch: sketch.feature,
    profiles: c.inside.map((p) => sketch.region(p)),
    sides: [{ distance: `${DEPTH} mm` }],
  });
  return { d, curve, sketch };
}

/** How far the sample point of a face lies, in the sketch plane, from the solved curve `root`. */
function offCurve(ev: Evaluation, d: DocBuilder, sketch: string, root: string, face: ShapeKey): number {
  const solved = ev.parts.get(d.partId)!.sketches.get(sketch)!.solved;
  const found = solved.curves.find((c) => 'drawn' in c.key && c.key.drawn.id === root);
  const p = ev.adapter.samplePoint(face);
  if (!found || !p) throw new Error('no curve or no sample point');
  return prepareCurve(found.shape, false)!.closest([p[0], p[1]])[0]!.distance;
}

describe('profiles bounded by ellipses, splines, beziers, conics and NURBS', () => {
  for (const c of CASES) {
    it(`extrudes ${c.name}, exactly, its side named after the curve`, () => {
      const { d, curve, sketch } = caseDoc(c, false);
      const ev = build(d);
      const detection = ev.parts.get(d.partId)!.sketches.get(sketch.feature)!.detection;
      // The picked regions are the largest; the format and the kernel both measure them as a fine polygon does.
      const picked = detection.regions
        .slice()
        .sort((a, b) => b.area - a.area)
        .slice(0, c.inside.length);
      const reference = picked.reduce((s, r) => s + polygonArea(detection, r), 0);
      expect(Math.abs(picked.reduce((s, r) => s + r.area, 0) - reference) / reference).toBeLessThan(1e-7);
      expect(Math.abs(capArea(ev, d) - reference) / reference).toBeLessThan(1e-7);
      const sides = sidesOf(ev, d, curve);
      expect(sides.length).toBe(c.inside.length);
      for (const f of sides) expect(offCurve(ev, d, sketch.feature, curve, f.key)).toBeLessThan(1e-6);
    });

    it(`keeps a pick on the side of ${c.name} when the curve changes shape`, () => {
      const before = caseDoc(c, false);
      const evA = build(before.d);
      const [side] = sidesOf(evA, before.d, before.curve);
      const record = writeRecord(side as NamedEntity, stateOf(evA, before.d), evA.adapter);
      const after = caseDoc(c, true);
      const evB = build(after.d);
      const found = resolve(record, stateOf(evB, after.d), evB.adapter);
      expect(found.outcome).toBe('same');
      if (found.outcome !== 'same') return;
      expect(found.entities).toHaveLength(1);
      const face = found.entities[0]!.key;
      expect(offCurve(evB, after.d, after.sketch.feature, after.curve, face)).toBeLessThan(1e-6);
      // On the same side of the dividing line as before, where there is one.
      const [pa, pb] = [evA.adapter.samplePoint(side!.key)!, evB.adapter.samplePoint(face)!];
      if (c.inside.length > 1) expect(Math.sign(pa[0] - 1.5)).toBe(Math.sign(pb[0] - 1.5));
    });
  }
});

describe('solved curve kinds in profiles', () => {
  /** An ellipse held by dimensions: centre fixed, major end level with it at `major`, minor radius set by a point on it. */
  function dimensioned(major: string, minorAt: number): { d: DocBuilder; curve: string; sketch: SketchHandle } {
    const d = new DocBuilder();
    let curve = '';
    const sketch = d.sketch('xy', (s) => {
      const center = s.point(0, 0);
      const majorEnd = s.point(8, 0);
      curve = s.curve('ellipse', { center, majorEnd, minorRadius: 3 });
      const top = s.point(0, minorAt);
      s.fixed(center);
      s.fixed(top);
      s.constraint('horizontal', { of: { points: { a: { point: { id: center } }, b: { point: { id: majorEnd } } } } });
      s.constraint('distance', {
        a: { point: { id: center } },
        b: { point: { id: majorEnd } },
        value: d.val(major),
        solved: 0,
        label: { auto: {} },
      });
      s.constraint('pointOnCurve', { point: { point: { id: top } }, curve: { curve: { id: curve } } });
    });
    d.extrude({ sketch: sketch.feature, profiles: [sketch.region([0.5, 0.5])], sides: [{ distance: `${DEPTH} mm` }] });
    return { d, curve, sketch };
  }

  it('solves an ellipse from its dimensions and keeps a pick on its side when one changes', () => {
    const a = dimensioned('8 mm', 3);
    const evA = build(a.d, true);
    expect(capArea(evA, a.d)).toBeCloseTo(Math.PI * 8 * 3, 6);
    const [side] = sidesOf(evA, a.d, a.curve);
    const record = writeRecord(side as NamedEntity, stateOf(evA, a.d), evA.adapter);
    const b = dimensioned('11 mm', 3);
    const evB = build(b.d, true);
    expect(capArea(evB, b.d)).toBeCloseTo(Math.PI * 11 * 3, 6);
    const found = resolve(record, stateOf(evB, b.d), evB.adapter);
    expect(found.outcome).toBe('same');
    if (found.outcome === 'same')
      expect(offCurve(evB, b.d, b.sketch.feature, b.curve, found.entities[0]!.key)).toBeLessThan(1e-6);
  });

  /** A plate with a spline-sided boss joined on top and an elliptical hole cut through both. */
  function bossed(
    lift: number,
    minor: number,
  ): { d: DocBuilder; boss: string; hole: string; sketches: [string, string] } {
    const d = new DocBuilder();
    const plate = d.sketch('xy', (s) => s.rect(0, 0, 40, 30));
    d.extrude({ sketch: plate.feature, profiles: [plate.region([1, 1])], sides: [{ distance: '5 mm' }] });
    let boss = '';
    const top = d.sketch(
      'xy',
      (s) => {
        const through = [s.point(5, 5), s.point(12, 10 + lift), s.point(20, 12), s.point(30, 5)];
        boss = s.curve('spline', { through });
        s.line(through[3] as string, through[0] as string);
      },
      5,
    );
    d.extrude({ sketch: top.feature, profiles: [top.region([15, 6])], sides: [{ distance: '6 mm' }], op: 'join' });
    let hole = '';
    const cut = d.sketch('xy', (s) => {
      hole = s.curve('ellipse', { center: s.point(17, 7.5), majorEnd: s.point(21, 7.5), minorRadius: minor });
    });
    d.extrude({ sketch: cut.feature, profiles: [cut.region([17, 7.5])], sides: [{ throughAll: true }], op: 'cut' });
    return { d, boss, hole, sketches: [top.feature, cut.feature] };
  }

  it('joins a spline-sided boss and cuts an elliptical hole, and picks on both stay when they change shape', () => {
    const a = bossed(0, 1.5);
    const evA = build(a.d);
    const bodies = entities(evA, a.d).filter((e) => e.kind === 'body');
    expect(bodies).toHaveLength(1);
    const records = [a.boss, a.hole].map((root) => {
      const [face] = sidesOf(evA, a.d, root);
      return writeRecord(face as NamedEntity, stateOf(evA, a.d), evA.adapter);
    });
    const b = bossed(3, 2);
    const evB = build(b.d);
    records.forEach((record, i) => {
      const found = resolve(record, stateOf(evB, b.d), evB.adapter);
      expect(found.outcome).toBe('same');
      if (found.outcome !== 'same') return;
      const root = [b.boss, b.hole][i] as string;
      for (const e of found.entities)
        expect(offCurve(evB, b.d, b.sketches[i] as string, root, e.key)).toBeLessThan(1e-6);
    });
  });

  it('pauses a conic whose rho is not between 0 and 1, and the extrude of its profile', () => {
    const d = new DocBuilder();
    let conic = '';
    const sketch = d.sketch('xy', (s) => {
      const [a, b] = [s.point(0, 0), s.point(10, 0)];
      conic = s.curve('conic', { start: a, apex: s.point(5, 8), end: b, rho: d.val('0.4') });
      s.line(b, a);
    });
    d.extrude({ sketch: sketch.feature, profiles: [sketch.region([5, 1])], sides: [{ distance: `${DEPTH} mm` }] });
    const doc = d.document() as Json;
    const timeline = ((doc.parts as Json[])[0] as Json).timeline as Json[];
    const row = (((timeline[0] as Json).inputs as Json).curves as Json[]).find((r) => r.id === conic) as Json;
    ((row.rho as Json).def as Json).expr = { text: '1.5', grammar: 1, refs: {} };
    expect(readDocument(JSON.parse(JSON.stringify(doc))).diagnostics.filter((x) => x.severity !== 'ignore')).toEqual(
      [],
    );
    const ev = evaluateDocument(doc, k, { solver: gcs });
    builds.push(ev);
    expect(ev.pauses.map((p) => p.feature)).toEqual([sketch.feature, timeline[1]!.id]);
    expect(ev.pauses[0]?.message).toMatch(/rho/);
  });
});
