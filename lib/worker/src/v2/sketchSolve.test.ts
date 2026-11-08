import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ValueEvaluator, base32Encode, prepareCurve, type CurveShape } from '@tweakcad/format';
import { curveGeometry, curveReader } from './sketchCurves';
import { SketchSolvePause, solveSketchPositions, type SolvedPositions } from './sketchSolve';

type Json = Record<string, unknown>;
let gcs: GcsWrapper;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [3, 4, 5]
    .map((up) => resolve(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'))
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
});

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string): Json => ({ id: id('val', nextValue++), def: { expr: { text, grammar: 1, refs: {} } } });
const P = (n: number) => ({ point: { id: id('pt', n) } });
const C = (n: number) => ({ curve: { id: id('crv', n) } });

/** A rectangle with a hole, roughly drawn, held by constraints and dimensions. */
function sketch(width: string, radius: string): Json {
  nextValue = 1;
  const rough = [
    [0, 0],
    [18, 1],
    [19, 11],
    [-1, 9],
  ];
  const line = (i: number) => ({
    id: id('crv', i + 1),
    kind: 'line',
    construction: val('false'),
    origin: { drawn: {} },
    start: id('pt', i + 1),
    end: id('pt', ((i + 1) % 4) + 1),
  });
  const dim = (n: number, kind: string, a: Json, b: Json | undefined, value: string): Json => ({
    id: id('con', n),
    kind,
    active: val('true'),
    ...(b ? { a, b } : { curve: a }),
    value: val(value),
    solved: 0,
    label: { auto: {} },
  });
  const geo = (n: number, kind: string, fields: Json): Json => ({
    id: id('con', n),
    kind,
    active: val('true'),
    ...fields,
  });
  return {
    points: [...rough.map(([x, y], i) => ({ id: id('pt', i + 1), x, y })), { id: id('pt', 9), x: 4, y: 6 }],
    curves: [0, 1, 2, 3].map(line).concat([
      {
        id: id('crv', 9),
        kind: 'circle',
        construction: val('false'),
        origin: { drawn: {} },
        center: id('pt', 9),
        radius: 1.5,
      } as never,
    ]),
    constraints: [
      geo(1, 'fixed', { point: P(1) }),
      geo(2, 'horizontal', { of: C(1) }),
      geo(3, 'vertical', { of: C(2) }),
      geo(4, 'horizontal', { of: C(3) }),
      geo(5, 'vertical', { of: C(4) }),
      dim(6, 'distanceX', P(1), P(2), width),
      dim(7, 'distanceY', P(1), P(4), '10 mm'),
      dim(8, 'radius', C(9), undefined, radius),
      dim(9, 'distanceX', P(1), P(9), '5 mm'),
      dim(10, 'distanceY', P(1), P(9), '5 mm'),
    ],
  };
}

const run = (s: Json) =>
  solveSketchPositions(
    s,
    new ValueEvaluator({ parts: [{ timeline: [{ inputs: s }], configurations: [] }], assemblies: [] }),
    gcs,
  );

describe('solving a version-2 sketch with planegcs', () => {
  it('moves the drawing to what its dimensions say', () => {
    const solved = run(sketch('20 mm', '2 mm'));
    const at = (n: number) => solved.points.get(id('pt', n));
    expect(at(1)).toEqual({ x: 0, y: 0 });
    expect(at(3)?.x).toBeCloseTo(20, 9);
    expect(at(3)?.y).toBeCloseTo(10, 9);
    expect(at(9)?.x).toBeCloseTo(5, 9);
    expect(solved.radii.get(id('crv', 9))).toBeCloseTo(2, 9);
  });

  it('follows a changed dimension value', () => {
    const solved = run(sketch('31 mm', '3 mm'));
    expect(solved.points.get(id('pt', 2))?.x).toBeCloseTo(31, 9);
    expect(solved.radii.get(id('crv', 9))).toBeCloseTo(3, 9);
  });

  it('pauses a constraint kind it does not solve yet', () => {
    const s = sketch('20 mm', '2 mm');
    (s.constraints as Json[]).push({ id: id('con', 30), kind: 'curvature', active: val('true'), a: C(1), b: C(9) });
    expect(() => run(s)).toThrow(SketchSolvePause);
  });
});

/** A sketch drawn row by row, for the curve kinds and constraints past lines and circles. */
class Draft {
  readonly points: Json[] = [];
  readonly curves: Json[] = [];
  readonly constraints: Json[] = [];
  private n = 0;

  private next(kind: string): string {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(12, ++this.n);
    bytes[0] = 7;
    return `${kind}_${base32Encode(bytes)}`;
  }

  val(text: string): Json {
    return { id: this.next('val'), def: { expr: { text, grammar: 1, refs: {} } } };
  }

  pt(x: number, y: number): string {
    const id = this.next('pt');
    this.points.push({ id, x, y });
    return id;
  }

  curve(kind: string, fields: Json): string {
    const id = this.next('crv');
    this.curves.push({ id, kind, construction: this.val('false'), origin: { drawn: {} }, ...fields });
    return id;
  }

  line(a: string, b: string): string {
    return this.curve('line', { start: a, end: b });
  }

  is(kind: string, fields: Json): string {
    const id = this.next('con');
    this.constraints.push({ id, kind, active: this.val('true'), ...fields });
    return id;
  }

  dim(kind: string, fields: Json, value: string): string {
    return this.is(kind, { ...fields, value: this.val(value), solved: 0, label: { auto: {} } });
  }

  fix(...points: string[]): void {
    for (const p of points) this.is('fixed', { point: { point: { id: p } } });
  }

  inputs(): Json {
    return {
      points: this.points,
      curves: this.curves,
      constraints: this.constraints,
      regions: [],
      retired: [],
      text: [],
    };
  }

  solve() {
    const s = this.inputs();
    const values = new ValueEvaluator({ parts: [{ timeline: [{ inputs: s }], configurations: [] }], assemblies: [] });
    const solved: SolvedPositions = solveSketchPositions(s, values, gcs);
    const at = (p: string): [number, number] => {
      const q = solved.points.get(p);
      if (!q) throw new Error(`no point ${p}`);
      return [q.x, q.y];
    };
    const reader = curveReader(values, new Map([...solved.points].map(([k, q]) => [k, [q.x, q.y] as const])), (c) =>
      solved.radii.get(c),
    );
    const shape = (c: string): CurveShape => curveGeometry(this.curves.find((r) => r.id === c) as Json, reader)!.shape;
    const on = (p: string, c: string) => prepareCurve(shape(c), false)!.closest(at(p))[0]!.distance;
    return { solved, at, shape, on };
  }
}

const P2 = (p: string) => ({ point: { id: p } });
const C2 = (c: string) => ({ curve: { id: c } });

/** An ellipse centred at the fixed origin with its major end level with the centre, `major` from it. */
function ellipse(
  d: Draft,
  major: number,
  minor: number,
  kind: 'ellipse' | 'ellipticalArc' = 'ellipse',
  ends?: [string, string],
) {
  const center = d.pt(0, 0);
  const majorEnd = d.pt(major + 0.3, 0.2);
  d.fix(center);
  d.is('horizontal', { of: { points: { a: P2(center), b: P2(majorEnd) } } });
  d.dim('distance', { a: P2(center), b: P2(majorEnd) }, `${major} mm`);
  const fields: Json = { center, majorEnd, minorRadius: minor };
  if (kind === 'ellipticalArc' && ends) Object.assign(fields, { start: ends[0], end: ends[1] });
  return { center, majorEnd, id: d.curve(kind, fields) };
}

describe('solving the curve kinds past lines, arcs and circles', () => {
  it('holds an ellipse by its major end, and a point on it sets its minor radius', () => {
    const d = new Draft();
    const e = ellipse(d, 8, 3);
    const q = d.pt(0.1, 2.4);
    d.fix(q);
    d.is('pointOnCurve', { point: P2(q), curve: C2(e.id) });
    const r = d.solve();
    expect(r.at(e.majorEnd)[0]).toBeCloseTo(8, 9);
    // On an ellipse with semi-axes 8 and b through (0.1, 2.4): (0.1/8)² + (2.4/b)² = 1.
    expect(r.solved.radii.get(e.id)).toBeCloseTo(2.4 / Math.sqrt(1 - (0.1 / 8) ** 2), 7);
    expect(r.on(q, e.id)).toBeLessThan(1e-7);
  });

  it("keeps an elliptical arc's ends on its ellipse", () => {
    const d = new Draft();
    const [s, t] = [d.pt(6, 1), d.pt(-1, 3.5)];
    const e = ellipse(d, 7, 3, 'ellipticalArc', [s, t]);
    d.dim('distanceY', { a: P2(e.center), b: P2(s) }, '1.5 mm');
    d.dim('distanceX', { a: P2(t), b: P2(e.center) }, '2 mm');
    const r = d.solve();
    expect(r.at(s)[1]).toBeCloseTo(1.5, 9);
    expect(r.at(t)[0]).toBeCloseTo(-2, 9);
    for (const p of [s, t]) {
      const [x, y] = r.at(p);
      expect((x / 7) ** 2 + (y / (r.solved.radii.get(e.id) as number)) ** 2).toBeCloseTo(1, 7);
    }
  });

  it('makes two ellipses equal, and a line tangent to one', () => {
    const d = new Draft();
    const a = ellipse(d, 8, 3);
    const c2 = d.pt(30, 0);
    const m2 = d.pt(36, 0.5);
    const b = d.curve('ellipse', { center: c2, majorEnd: m2, minorRadius: 2 });
    d.fix(c2);
    d.is('horizontal', { of: { points: { a: P2(c2), b: P2(m2) } } });
    d.is('equal', { a: C2(a.id), b: C2(b) });
    const [l1, l2] = [d.pt(-10, 3.4), d.pt(10, 3.6)];
    const line = d.line(l1, l2);
    d.is('horizontal', { of: C2(line) });
    d.is('tangent', { a: C2(line), b: C2(a.id), internal: d.val('false') });
    d.dim('distanceY', { a: P2(a.center), b: P2(l1) }, '2.5 mm');
    const r = d.solve();
    expect(r.solved.radii.get(a.id)).toBeCloseTo(2.5, 7);
    expect(r.solved.radii.get(b)).toBeCloseTo(2.5, 7);
    expect(r.at(m2)[0]).toBeCloseTo(38, 7);
  });

  it('holds points on a bezier, a conic and a NURBS', () => {
    const d = new Draft();
    const [b0, b1, b2, b3] = [d.pt(0, 0), d.pt(2, 6), d.pt(8, 6), d.pt(10, 0)];
    const bez = d.curve('bezier', { start: b0, c1: b1, c2: b2, end: b3 });
    const [k0, k1, k2] = [d.pt(20, 0), d.pt(25, 8), d.pt(30, 0)];
    const conic = d.curve('conic', { start: k0, apex: k1, end: k2, rho: d.val('0.3') });
    const poles = [d.pt(40, 0), d.pt(42, 5), d.pt(46, 6), d.pt(50, 2), d.pt(52, 0)];
    const nurbs = d.curve('nurbs', {
      degree: d.val('3'),
      poles,
      weights: [1, 2, 1, 1, 1].map((w) => d.val(String(w))),
      knots: [0, 0.5, 1].map((u) => d.val(String(u))),
      multiplicities: [4, 1, 4],
      periodic: d.val('false'),
    });
    d.fix(b0, b1, b2, b3, k0, k1, k2, ...poles);
    const on = [d.pt(5, 3), d.pt(25, 2), d.pt(46, 4)] as [string, string, string];
    for (const [p, c] of [
      [on[0], bez],
      [on[1], conic],
      [on[2], nurbs],
    ] as [string, string][]) {
      d.is('pointOnCurve', { point: P2(p), curve: C2(c) });
    }
    d.dim('distanceX', { a: P2(b0), b: P2(on[0]) }, '4 mm');
    d.dim('distanceX', { a: P2(k0), b: P2(on[1]) }, '5 mm');
    d.dim('distanceX', { a: P2(poles[0] as string), b: P2(on[2]) }, '7 mm');
    const r = d.solve();
    expect(r.on(on[0], bez)).toBeLessThan(1e-7);
    expect(r.on(on[1], conic)).toBeLessThan(1e-7);
    // The conic's shoulder: rho of the way from the chord's midpoint to the apex.
    expect(r.at(on[1])[1]).toBeCloseTo(8 * 0.3, 7);
    expect(r.on(on[2], nurbs)).toBeLessThan(1e-7);
  });

  it('makes a bezier tangent to a line and to an arc at its shared ends', () => {
    const d = new Draft();
    const [l0, p] = [d.pt(-10, 0), d.pt(0, 0)];
    const line = d.line(l0, p);
    const [c1, c2, q] = [d.pt(3, 1), d.pt(7, 4), d.pt(10, 5)];
    const bez = d.curve('bezier', { start: p, c1, c2, end: q });
    const [center, arcEnd] = [d.pt(10, 10), d.pt(15, 10)];
    const arc = d.curve('arc', { center, start: arcEnd, end: q });
    d.fix(l0, p, center, arcEnd, c2);
    d.is('tangent', { a: C2(line), b: C2(bez), internal: d.val('false') });
    d.is('tangent', { a: C2(bez), b: C2(arc), internal: d.val('false') });
    const r = d.solve();
    // c1 on the line's direction; the tangent at q (towards c2) square to the radius there.
    expect(r.at(c1)[1]).toBeCloseTo(0, 9);
    const [qx, qy] = r.at(q);
    const [cx, cy] = r.at(center);
    const [kx, ky] = r.at(c2);
    expect((kx - qx) * (qx - cx) + (ky - qy) * (qy - cy)).toBeCloseTo(0, 7);
    expect(Math.hypot(qx - cx, qy - cy)).toBeCloseTo(5, 7);
  });

  it('makes an elliptical arc tangent to an arc at their shared end', () => {
    const d = new Draft();
    const [s, t] = [d.pt(7, 0.2), d.pt(0.5, 3.1)];
    const e = ellipse(d, 7, 3, 'ellipticalArc', [s, t]);
    d.dim('distanceY', { a: P2(e.center), b: P2(s) }, '0 mm');
    const [center, far] = [d.pt(0.3, 5), d.pt(-2, 5)];
    const arc = d.curve('arc', { center, start: t, end: far });
    const top = d.pt(0, 3);
    d.fix(top);
    d.is('pointOnCurve', { point: P2(top), curve: C2(e.id) });
    d.dim('radius', { curve: C2(arc) }, '2 mm');
    d.dim('distanceX', { a: P2(e.center), b: P2(t) }, '0.5 mm');
    d.is('tangent', { a: C2(e.id), b: C2(arc), internal: d.val('false') });
    const r = d.solve();
    // The ellipse's tangent at t is square to the arc's radius there.
    const minor = r.solved.radii.get(e.id) as number;
    expect(minor).toBeCloseTo(3, 7);
    const [x, y] = r.at(t);
    const tangent = [-7 * Math.sin(Math.atan2(y / minor, x / 7)), minor * Math.cos(Math.atan2(y / minor, x / 7))];
    const [cx, cy] = r.at(center);
    expect(tangent[0]! * (x - cx) + tangent[1]! * (y - cy)).toBeCloseTo(0, 6);
    expect((x / 7) ** 2 + (y / minor) ** 2).toBeCloseTo(1, 7);
  });

  it('solves collinear, coradial, offset, normal and an angle to the sketch x axis', () => {
    const d = new Draft();
    const [a0, a1, b0, b1] = [d.pt(0, 0), d.pt(10, 0), d.pt(12, 0.5), d.pt(20, 0.8)];
    const [a, b] = [d.line(a0, a1), d.line(b0, b1)];
    d.fix(a0);
    d.dim('angle', { a: C2(a), b: { sketchX: {} } }, '-30 deg');
    d.is('collinear', { a: C2(a), b: C2(b) });
    const [o0, o1] = [d.pt(0, 3), d.pt(10, 8)];
    const off = d.line(o0, o1);
    d.is('offset', { a: C2(a), b: C2(off), distance: d.val('2 mm') });
    const center = d.pt(30, 0);
    d.fix(center);
    const circle = d.curve('circle', { center, radius: 4 });
    d.dim('radius', { curve: C2(circle) }, '4 mm');
    const [c2, s, e] = [d.pt(30.2, 0.1), d.pt(34, 1), d.pt(29, 4)];
    const arc = d.curve('arc', { center: c2, start: s, end: e });
    d.is('coradial', { a: C2(circle), b: C2(arc) });
    const ring = d.curve('circle', { center, radius: 7 });
    d.is('offset', { a: C2(circle), b: C2(ring), distance: d.val('1.5 mm') });
    const [n0, n1] = [d.pt(40, 1), d.pt(50, 3)];
    const normal = d.line(n0, n1);
    d.is('normal', { a: C2(normal), b: C2(circle) });
    d.fix(n1);
    const r = d.solve();
    const dir = (p: string, q: string) => {
      const [x0, y0] = r.at(p);
      const [x1, y1] = r.at(q);
      return Math.atan2(y1 - y0, x1 - x0);
    };
    // Counter-clockwise from the line to the sketch x axis, as between two lines.
    expect(dir(a0, a1)).toBeCloseTo(Math.PI / 6, 9);
    expect(dir(b0, b1)).toBeCloseTo(Math.PI / 6, 7);
    expect(Math.sin(Math.PI / 6) * r.at(b0)[0] - Math.cos(Math.PI / 6) * r.at(b0)[1]).toBeCloseTo(0, 7);
    expect(Math.abs(Math.sin(dir(o0, o1) - Math.PI / 6))).toBeLessThan(1e-7);
    expect(Math.cos(Math.PI / 6) * r.at(o0)[1] - Math.sin(Math.PI / 6) * r.at(o0)[0]).toBeCloseTo(2, 7);
    expect(r.at(c2)[0]).toBeCloseTo(30, 7);
    expect(r.at(c2)[1]).toBeCloseTo(0, 7);
    expect(Math.hypot(r.at(s)[0] - 30, r.at(s)[1])).toBeCloseTo(4, 7);
    expect(r.solved.radii.get(ring)).toBeCloseTo(5.5, 7);
    // The normal line runs through the circle's centre.
    const [x0, y0] = r.at(n0);
    const [x1, y1] = r.at(n1);
    expect((x1 - x0) * (0 - y0) - (y1 - y0) * (30 - x0)).toBeCloseTo(0, 7);
  });

  it('blocks a curve where it is, and solves arc midpoints, mirrored circles and distances to curves', () => {
    const d = new Draft();
    const center = d.pt(0, 0);
    const held = d.curve('circle', { center, radius: 3 });
    d.is('block', { curve: C2(held) });
    const p = d.pt(5, 1);
    d.dim('distance', { a: P2(p), b: C2(held) }, '1 mm');
    d.is('horizontal', { of: { points: { a: P2(center), b: P2(p) } } });
    const [ac, as, ae] = [d.pt(20, 0), d.pt(25, 0), d.pt(20, 5)];
    const arc = d.curve('arc', { center: ac, start: as, end: ae });
    d.is('block', { curve: C2(arc) });
    const mid = d.pt(23, 3);
    d.is('midpoint', { point: P2(mid), curve: C2(arc) });
    const [x0, x1] = [d.pt(40, -5), d.pt(40, 5)];
    const axis = d.line(x0, x1);
    d.fix(x0, x1);
    const [m1, m2] = [d.pt(36, 1), d.pt(43, 0.5)];
    const [left, right] = [
      d.curve('circle', { center: m1, radius: 1 }),
      d.curve('circle', { center: m2, radius: 1.4 }),
    ];
    d.fix(m1);
    d.dim('radius', { curve: C2(left) }, '1 mm');
    d.is('symmetric', { a: C2(left), b: C2(right), axis: C2(axis) });
    const q = d.pt(45, 3);
    d.dim('distance', { a: P2(q), b: C2(axis) }, '2.5 mm');
    d.is('horizontal', { of: { points: { a: P2(m2), b: P2(q) } } });
    const r = d.solve();
    expect(r.solved.radii.get(held)).toBeCloseTo(3, 12);
    expect(r.at(center)).toEqual([0, 0]);
    expect(r.at(p)[0]).toBeCloseTo(4, 7);
    expect(r.at(mid)[0]).toBeCloseTo(20 + 5 * Math.SQRT1_2, 7);
    expect(r.at(mid)[1]).toBeCloseTo(5 * Math.SQRT1_2, 7);
    expect(r.at(m2)[0]).toBeCloseTo(44, 7);
    expect(r.at(m2)[1]).toBeCloseTo(1, 7);
    expect(r.solved.radii.get(right)).toBeCloseTo(1, 7);
    expect(r.at(q)[0]).toBeCloseTo(42.5, 7);
  });

  it("holds points to the sketch's origin and axes, which never move", () => {
    const d = new Draft();
    const O = { sketchStandard: { name: 'origin' } };
    const X = { sketchStandard: { name: 'x' } };
    const Y = { sketchStandard: { name: 'y' } };
    // A point at the origin, by horizontal and vertical against it.
    const p = d.pt(0.4, -0.3);
    d.is('horizontal', { of: { points: { a: O, b: P2(p) } } });
    d.is('vertical', { of: { points: { a: O, b: P2(p) } } });
    // A line from it, one end on the x axis, then parallel to the y axis.
    const q = d.pt(9, 0.7);
    d.is('pointOnCurve', { point: P2(q), curve: X });
    d.dim('distanceX', { a: O, b: P2(q) }, '12 mm');
    const [s, e] = [d.pt(20, 1), d.pt(21, 9)];
    const l = d.line(s, e);
    d.is('parallel', { a: C2(l), b: Y });
    d.dim('distance', { a: P2(s), b: Y }, '25 mm');
    d.dim('angle', { a: X, b: C2(d.line(d.pt(1, 1), d.pt(5, 2))) }, '30 deg');
    // A point held at a distance from the origin, on the y axis.
    const t = d.pt(0.5, 6);
    d.is('pointOnCurve', { point: P2(t), curve: Y });
    d.dim('distance', { a: O, b: P2(t) }, '7 mm');
    const r = d.solve();
    expect(r.at(t)[0]).toBeCloseTo(0, 9);
    expect(r.at(t)[1]).toBeCloseTo(7, 9);
    expect(r.at(p)[0]).toBeCloseTo(0, 9);
    expect(r.at(p)[1]).toBeCloseTo(0, 9);
    expect(r.at(q)[0]).toBeCloseTo(12, 9);
    expect(r.at(q)[1]).toBeCloseTo(0, 9);
    expect(r.at(s)[0]).toBeCloseTo(r.at(e)[0], 9);
    expect(Math.abs(r.at(s)[0])).toBeCloseTo(25, 9);
    const a = d.curves.at(-1) as Json;
    const [a0, a1] = [r.at(a.start as string), r.at(a.end as string)];
    expect(Math.atan2(a1[1] - a0[1], a1[0] - a0[0])).toBeCloseTo(Math.PI / 6, 9);
    // The standard geometry is the solver's own: it is not among the solved points.
    expect([...r.solved.points.keys()].every((k) => k.startsWith('pt_'))).toBe(true);
  });

  it('pauses what the solver cannot express', () => {
    const cases: [string, (d: Draft) => void][] = [
      [
        'curvature',
        (d) => {
          const [a, b, c] = [d.pt(0, 0), d.pt(5, 0), d.pt(9, 3)];
          d.is('curvature', {
            a: C2(d.line(a, b)),
            b: C2(d.curve('bezier', { start: b, c1: d.pt(7, 0), c2: d.pt(8, 1), end: c })),
          });
        },
      ],
      [
        'a spline curve operand',
        (d) => {
          const s = d.curve('spline', { through: [d.pt(0, 0), d.pt(3, 2), d.pt(6, 0)] });
          d.is('pointOnCurve', { point: P2(d.pt(3, 1)), curve: C2(s) });
        },
      ],
      [
        'tangency to a bezier away from its ends',
        (d) => {
          const b = d.curve('bezier', { start: d.pt(0, 0), c1: d.pt(2, 3), c2: d.pt(4, 3), end: d.pt(6, 0) });
          d.is('tangent', {
            a: C2(d.curve('circle', { center: d.pt(3, 6), radius: 2 })),
            b: C2(b),
            internal: d.val('false'),
          });
        },
      ],
      [
        'an ellipse whose minor radius is the longer',
        (d) => {
          d.curve('ellipse', { center: d.pt(0, 0), majorEnd: d.pt(2, 0), minorRadius: 3 });
        },
      ],
      [
        'an offset ellipse',
        (d) => {
          const a = d.curve('ellipse', { center: d.pt(0, 0), majorEnd: d.pt(5, 0), minorRadius: 2 });
          const b = d.curve('ellipse', { center: d.pt(0, 0), majorEnd: d.pt(6, 0), minorRadius: 3 });
          d.is('offset', { a: C2(a), b: C2(b), distance: d.val('1 mm') });
        },
      ],
    ];
    for (const [name, draw] of cases) {
      const d = new Draft();
      draw(d);
      expect(() => d.solve(), name).toThrow(SketchSolvePause);
    }
  });
});

describe('mirror images', () => {
  /** An arc held by a fixed centre and a radius, and a copy held as its image in the fixed line x = 10. */
  function mirroredArc(tie: 'points' | 'curves') {
    const d = new Draft();
    const [x0, x1] = [d.pt(10, -5), d.pt(10, 5)];
    const axis = d.line(x0, x1);
    d.fix(x0, x1);
    const [c, s, e] = [d.pt(0, 0), d.pt(4, 0.2), d.pt(0.3, 4)];
    d.fix(c);
    const arc = d.curve('arc', { center: c, start: s, end: e });
    d.is('horizontal', { of: { points: { a: P2(c), b: P2(s) } } });
    d.is('vertical', { of: { points: { a: P2(c), b: P2(e) } } });
    d.dim('radius', { curve: C2(arc) }, '5 mm');
    // Mirrored, it runs the other way round: from the image of the end to that of the start.
    const [c2, s2, e2] = [d.pt(20.5, 0.3), d.pt(20, 4.2), d.pt(16.3, 0)];
    const copy = d.curve('arc', { center: c2, start: s2, end: e2 });
    if (tie === 'curves') d.is('symmetric', { a: C2(arc), b: C2(copy), axis: C2(axis) });
    else {
      for (const [p, q] of [
        [c, c2],
        [e, s2],
        [s, e2],
      ] as const)
        d.is('symmetric', { a: P2(p), b: P2(q), axis: C2(axis) });
    }
    const r = d.solve();
    return { r, copy, c2, s2, e2 };
  }

  for (const tie of ['points', 'curves'] as const) {
    it(`holds an arc mirrored by symmetric ${tie} with no redundant equation`, () => {
      const { r, copy, c2, s2, e2 } = mirroredArc(tie);
      expect(gcs.get_gcs_redundant_constraints()).toEqual([]);
      expect(gcs.gcs.dof()).toBe(0);
      expect(r.at(c2)[0]).toBeCloseTo(20, 9);
      expect(r.at(c2)[1]).toBeCloseTo(0, 9);
      expect(r.at(s2)[0]).toBeCloseTo(20, 9);
      expect(r.at(s2)[1]).toBeCloseTo(5, 9);
      expect(r.at(e2)[0]).toBeCloseTo(15, 9);
      expect(r.at(e2)[1]).toBeCloseTo(0, 9);
      expect(r.solved.radii.get(copy)).toBeCloseTo(5, 9);
    });
  }

  it('holds an ellipse mirrored by symmetric points and equal, taking none of its freedom', () => {
    const d = new Draft();
    const { center, majorEnd, id } = ellipse(d, 6, 3);
    d.solve();
    const dof = gcs.gcs.dof();
    const [x0, x1] = [d.pt(10, -5), d.pt(10, 5)];
    const axis = d.line(x0, x1);
    d.fix(x0, x1);
    const [c2, m2] = [d.pt(20.4, 0.2), d.pt(13.5, -0.3)];
    const copy = d.curve('ellipse', { center: c2, majorEnd: m2, minorRadius: 2 });
    d.is('symmetric', { a: P2(center), b: P2(c2), axis: C2(axis) });
    d.is('symmetric', { a: P2(majorEnd), b: P2(m2), axis: C2(axis) });
    d.is('equal', { a: C2(id), b: C2(copy) });
    const r = d.solve();
    expect(gcs.get_gcs_redundant_constraints()).toEqual([]);
    expect(gcs.gcs.dof()).toBe(dof);
    expect(r.at(c2)[0]).toBeCloseTo(20, 9);
    expect(r.at(m2)[0]).toBeCloseTo(14, 9);
    expect(r.solved.radii.get(copy)).toBeCloseTo(r.solved.radii.get(id) as number, 9);
  });
});
