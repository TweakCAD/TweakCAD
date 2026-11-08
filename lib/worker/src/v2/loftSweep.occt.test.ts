/**
 * Loft and sweep on the real kernel: sections, paths and orientations, the
 * walls and caps they name, edits that keep a pick on its face, the operation,
 * and the cases that pause.
 */
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
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(doc: Json): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = evaluate(d.document());
  expect(ev.pauses.map((p) => p.message)).toEqual([]);
  return ev;
}

/** The one pause a document ends on. */
function pauseOf(d: DocBuilder): string {
  const { pauses } = evaluate(d.document());
  expect(pauses).toHaveLength(1);
  return (pauses[0] as { message: string }).message;
}

const all = (ev: Evaluation, d: DocBuilder) => [...(ev.parts.get(d.partId)?.state.entities.values() ?? [])];
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const bodyVolume = (ev: Evaluation, d: DocBuilder) => volume(ev, bodies(ev, d)[0] as NamedEntity);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const faces = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const facesOf = (ev: Evaluation, d: DocBuilder, role: string) => faces(ev, d).filter((e) => roleOf(ev, e) === role);
const distinctNames = (list: NamedEntity[]) => new Set(list.map((e) => e.ladder.join('/'))).size;
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) =>
  writeRecord(e, ev.parts.get(d.partId)!.state, ev.adapter);

/** The names of an evaluation, for a reference to one of its entities written into `d`. */
function adopt(d: DocBuilder, ev: Evaluation): void {
  for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
}

/** The face a pick resolves to, which must be one. */
function found(ev: Evaluation, d: DocBuilder, record: EntityRecord): ShapeKey {
  const result = resolve(record, ev.parts.get(d.partId)!.state, ev.adapter);
  expect(result.outcome).toBe('same');
  return result.outcome === 'same' ? (result.entities[0]?.key as ShapeKey) : -1;
}

/** A reference to a sketch curve. */
function curveRef(d: DocBuilder, feature: string, curve: string): Json {
  const ladder = ladderOf({ kind: 'curve', chain: [], feature, role: 'curve', src: [idItem(curve)] }, d.names);
  return { entity: { id: ladder, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
}

const operation = (d: DocBuilder, op = 'new') => ({
  op: d.val(`"${op}"`),
  targets: { all: {} },
  keepTools: d.val('false'),
});
const rows = (d: DocBuilder, sections: Json[]) => sections.map((section) => ({ id: d.id('sec'), section }));
const profiles = (...refs: Json[]) => ({ profiles: makeSet(refs) as unknown as Json });

function loft(
  d: DocBuilder,
  sections: Json[],
  o: { ruled?: boolean; closed?: boolean; op?: string; extra?: Json } = {},
): string {
  return d.feature('core.loft', {
    sections: rows(d, sections),
    rails: [],
    ruled: d.val(String(o.ruled ?? false)),
    closed: d.val(String(o.closed ?? false)),
    operation: operation(d, o.op),
    ...o.extra,
  });
}

function sweep(
  d: DocBuilder,
  sections: Json[],
  path: Json[],
  o: { orientation?: Json; op?: string; extra?: Json } = {},
): string {
  return d.feature('core.sweep', {
    sections: rows(d, sections),
    path,
    orientation: o.orientation ?? { followPath: {} },
    operation: operation(d, o.op),
    ...o.extra,
  });
}

/** A square of half-width `half` on the xy plane at height `z`, and the section reference to it. */
function squareAt(d: DocBuilder, half: number, z: number): { sketch: SketchHandle; section: Json } {
  const sketch = d.sketch('xy', (s) => s.rect(-half, -half, 2 * half, 2 * half), z);
  return { sketch, section: profiles(sketch.region([0, 0])) };
}

function circleAt(d: DocBuilder, r: number, z: number): Json {
  return profiles(d.sketch('xy', (s) => s.circle(0, 0, r), z).region([0, 0]));
}

/** The open polyline through the (x, z) `points` on the xz plane, as a curve chain. */
function polyline(d: DocBuilder, points: [number, number][]): Json[] {
  let lines: string[] = [];
  const sketch = d.sketch('xz', (s: SketchDraw) => {
    const ids = points.map(([x, z]) => s.point(x, -z));
    lines = ids.slice(1).map((p, i) => s.line(ids[i] as string, p));
  });
  return lines.map((l) => curveRef(d, sketch.feature, l));
}

/** Two squares a loft joins, half-widths `a` and `b`, 10 apart. */
function frustum(a = 5, b = 3): { d: DocBuilder; id: string } {
  const d = new DocBuilder();
  const [low, high] = [squareAt(d, a, 0), squareAt(d, b, 10)];
  return { d, id: loft(d, [low.section, high.section]) };
}

/** Four sections in planes through the z axis, around it. */
function ringSections(d: DocBuilder): Json[] {
  return [
    d.sketch('xz', (s) => s.rect(8, -2, 4, 4)).region([10, 0]),
    d.sketch('yz', (s) => s.rect(-2, 8, 4, 4)).region([0, 10]),
    d.sketch('xz', (s) => s.rect(-12, -2, 4, 4)).region([-10, 0]),
    d.sketch('yz', (s) => s.rect(-2, -12, 4, 4)).region([0, -10]),
  ];
}

describe('core.loft', () => {
  it('builds through two sections, naming the walls and the caps', () => {
    const { d } = frustum();
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo((10 / 3) * (100 + 36 + 60), 5);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
    expect(distinctNames(facesOf(ev, d, 'side'))).toBe(4);
    const [start, end] = [facesOf(ev, d, 'start'), facesOf(ev, d, 'end')];
    expect(start).toHaveLength(1);
    expect(end).toHaveLength(1);
    expect(centroid(ev, (start[0] as NamedEntity).key)[2]).toBeCloseTo(0, 6);
    expect(centroid(ev, (end[0] as NamedEntity).key)[2]).toBeCloseTo(10, 6);
  });

  it('builds between sections of different edge counts, each face with a name of its own', () => {
    const d = new DocBuilder();
    loft(d, [squareAt(d, 5, 0).section, circleAt(d, 3, 10)]);
    const ev = build(d);
    const walls = facesOf(ev, d, 'side');
    expect(faces(ev, d)).toHaveLength(walls.length + 2);
    expect(walls.length).toBeGreaterThan(4);
    expect(distinctNames(walls)).toBe(walls.length);
  });

  it('runs smoothly through three sections, a face spanning them all', () => {
    const d = new DocBuilder();
    loft(d, [squareAt(d, 5, 0).section, squareAt(d, 3, 5).section, squareAt(d, 5, 10).section]);
    const ev = build(d);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
    expect(distinctNames(facesOf(ev, d, 'side'))).toBe(4);
  });

  it('a ruled loft has a face for each pair of sections, named after that pair', () => {
    const d = new DocBuilder();
    loft(d, [squareAt(d, 5, 0).section, squareAt(d, 4, 5).section, squareAt(d, 6, 10).section], { ruled: true });
    const ev = build(d);
    const walls = facesOf(ev, d, 'side');
    expect(walls).toHaveLength(8);
    expect(distinctNames(walls)).toBe(8);
    const heights = walls.map((w) => Math.round(centroid(ev, w.key)[2] * 2) / 2);
    expect(heights.filter((z) => z < 5)).toHaveLength(4);
    expect(heights.filter((z) => z > 5)).toHaveLength(4);
  });

  it('keeps a pick on its wall when a section changes', () => {
    const { d } = frustum();
    const before = build(d);
    const wall = facesOf(before, d, 'side').find((w) => centroid(before, w.key)[0] > 3) as NamedEntity;
    const record = pick(before, d, wall);
    const { d: changed } = frustum(7, 2);
    const after = build(changed);
    expect(centroid(after, found(after, changed, record))[0]).toBeGreaterThan(2);
  });

  it('ends on a point, with no cap there', () => {
    const d = new DocBuilder();
    loft(d, [squareAt(d, 5, 0).section, { point: { at: { v: d.val('vector(0 mm, 0 mm, 12 mm)') } } }]);
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo((100 * 12) / 3, 5);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
    expect(facesOf(ev, d, 'start')).toHaveLength(1);
    expect(facesOf(ev, d, 'end')).toEqual([]);
  });

  it('lofts from a face of a body', () => {
    const d = new DocBuilder();
    const base = squareAt(d, 5, 0);
    d.extrude({ sketch: base.sketch.feature, profiles: [base.sketch.region([0, 0])], sides: [{ distance: '4 mm' }] });
    const before = build(d);
    const top = faces(before, d).find(
      (f) => Math.abs((centroid(before, f.key)[2] as number) - 4) < 1e-6,
    ) as NamedEntity;
    const record = pick(before, d, top);
    adopt(d, before);
    loft(d, [{ face: { entity: record } }, squareAt(d, 2, 10).section], { op: 'join' });
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(bodyVolume(ev, d)).toBeCloseTo(400 + 2 * (100 + 16 + 40), 4);
  });

  it('closes on its first section, with no caps', () => {
    const d = new DocBuilder();
    const sections = ringSections(d);
    loft(
      d,
      sections.map((s) => profiles(s)),
      { closed: true },
    );
    const ev = build(d);
    expect(facesOf(ev, d, 'start')).toEqual([]);
    expect(facesOf(ev, d, 'end')).toEqual([]);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
    expect(bodyVolume(ev, d)).toBeCloseTo(1083.6, 0);
  });

  it('does not twist a closed loft, wherever the sections start', () => {
    // Sketches that draw the same squares from other corners, and the other way round.
    const square = (s: SketchDraw, cx: number, cy: number, start: number, flip: boolean) => {
      const corners = [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ].map(([x, y]) => s.point(cx + (x as number), cy + (y as number)));
      if (flip) corners.reverse();
      for (let i = 0; i < 4; i++) s.line(corners[(start + i) % 4] as string, corners[(start + i + 1) % 4] as string);
    };
    for (const [starts, flips] of [
      [
        [0, 1, 2, 3],
        [false, true, false, true],
      ],
      [
        [3, 0, 1, 1],
        [true, true, false, false],
      ],
      [
        [2, 3, 0, 1],
        [false, false, false, true],
      ],
    ] as [number[], boolean[]][]) {
      const d = new DocBuilder();
      const at = (i: number) => [starts[i] as number, flips[i] as boolean] as const;
      const sections = [
        d.sketch('xz', (s) => square(s, 10, 0, ...at(0))).region([10, 0]),
        d.sketch('yz', (s) => square(s, 0, 10, ...at(1))).region([0, 10]),
        d.sketch('xz', (s) => square(s, -10, 0, ...at(2))).region([-10, 0]),
        d.sketch('yz', (s) => square(s, 0, -10, ...at(3))).region([0, -10]),
      ];
      loft(
        d,
        sections.map((s) => profiles(s)),
        { closed: true, ruled: true },
      );
      expect(bodyVolume(build(d), d)).toBeCloseTo(640, 4);
    }
  });

  it('pauses a closed loft whose sections differ in edges, which it cannot line up', () => {
    const d = new DocBuilder();
    const sections = [
      d.sketch('xz', (s) => s.rect(8, -2, 4, 4)).region([10, 0]),
      d.sketch('yz', (s) => s.circle(0, 10, 2)).region([0, 10]),
      d.sketch('xz', (s) => s.rect(-12, -2, 4, 4)).region([-10, 0]),
      d.sketch('yz', (s) => s.circle(0, -10, 2)).region([0, -10]),
    ];
    loft(
      d,
      sections.map((s) => profiles(s)),
      { closed: true },
    );
    expect(pauseOf(d)).toMatch(/same number of edges/);
  });

  it('cuts a body', () => {
    const d = new DocBuilder();
    const base = d.sketch('xy', (s) => s.rect(-10, -10, 20, 20), -1);
    d.extrude({ sketch: base.feature, profiles: [base.region([0, 0])], sides: [{ distance: '12 mm' }] });
    loft(d, [squareAt(d, 5, -1).section, squareAt(d, 5, 11).section], { op: 'cut' });
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo(400 * 12 - 100 * 12, 4);
  });

  it('keeps the outer loop of a section with a hole', () => {
    const d = new DocBuilder();
    const holed = d.sketch('xy', (s) => {
      s.rect(-5, -5, 10, 10);
      s.circle(0, 0, 2);
    });
    loft(d, [profiles(holed.region([4, 4])), squareAt(d, 5, 10).section]);
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo(1000, 5);
  });

  it('pauses on what it cannot build', () => {
    const closedTwo = new DocBuilder();
    loft(closedTwo, [squareAt(closedTwo, 5, 0).section, squareAt(closedTwo, 3, 10).section], { closed: true });
    expect(pauseOf(closedTwo)).toMatch(/at least three/);

    const middle = new DocBuilder();
    loft(middle, [
      squareAt(middle, 5, 0).section,
      { point: { at: { v: middle.val('vector(0 mm, 0 mm, 5 mm)') } } },
      squareAt(middle, 5, 10).section,
    ]);
    expect(pauseOf(middle)).toMatch(/only starts or ends/);

    const two = new DocBuilder();
    const pair = two.sketch('xy', (s) => {
      s.rect(-5, -5, 3, 3);
      s.rect(2, 2, 3, 3);
    });
    loft(two, [profiles(pair.region([-4, -4]), pair.region([3, 3])), squareAt(two, 3, 10).section]);
    expect(pauseOf(two)).toMatch(/one region/);

    const railed = new DocBuilder();
    const rail = polyline(railed, [
      [5, 0],
      [5, 10],
    ]);
    railed.feature('core.loft', {
      sections: rows(railed, [squareAt(railed, 5, 0).section, squareAt(railed, 5, 10).section]),
      rails: [rail],
      ruled: railed.val('false'),
      closed: railed.val('false'),
      operation: operation(railed),
    });
    expect(pauseOf(railed)).toMatch(/rails/);
  });
});

describe('core.sweep', () => {
  /** A square section on the xy plane, and a path up the z axis and along x. */
  function elbow(half = 2, leg = 20): { d: DocBuilder; section: Json; path: Json[] } {
    const d = new DocBuilder();
    const { section } = squareAt(d, half, 0);
    const path = polyline(d, [
      [0, 0],
      [0, leg],
      [leg, leg],
    ]);
    return { d, section, path };
  }

  it('runs a circle round a circle, as a torus with no caps', () => {
    const d = new DocBuilder();
    const section = profiles(d.sketch('xz', (s) => s.circle(30, 0, 5)).region([30, 0]));
    const path = d.sketch('xy', (s) => s.circle(0, 0, 30)).region([0, 0]);
    sweep(d, [section], [path]);
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo(2 * Math.PI * Math.PI * 30 * 25, 2);
    expect(facesOf(ev, d, 'side')).toHaveLength(1);
    expect(facesOf(ev, d, 'start')).toEqual([]);
  });

  it('mitres the corners of a path, and names each wall by its section and path segments', () => {
    const { d, section, path } = elbow();
    sweep(d, [section], path);
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo(16 * 40, 5);
    const walls = facesOf(ev, d, 'side');
    expect(walls).toHaveLength(8);
    expect(distinctNames(walls)).toBe(8);
    expect(facesOf(ev, d, 'start')).toHaveLength(1);
    expect(facesOf(ev, d, 'end')).toHaveLength(1);
  });

  it('takes the curves of a path in any order, and a section at either end of it', () => {
    const { d, section, path } = elbow();
    sweep(d, [section], [...path].reverse());
    expect(bodyVolume(build(d), d)).toBeCloseTo(16 * 40, 5);

    const far = new DocBuilder();
    const end = far.sketch('yz', (s) => s.rect(-22, -2, 4, 4), 20).region([-20, 0]);
    sweep(
      far,
      [profiles(end)],
      polyline(far, [
        [0, 0],
        [0, 20],
        [20, 20],
      ]),
    );
    expect(bodyVolume(build(far), far)).toBeCloseTo(16 * 40, 5);
  });

  it('goes round a closed polygon, with no caps', () => {
    const d = new DocBuilder();
    const section = profiles(d.sketch('xz', (s) => s.rect(18, -1, 4, 2)).region([20, 0]));
    const path = d.sketch('xy', (s) => s.rect(-20, -20, 40, 40)).region([0, 0]);
    sweep(d, [section], [path]);
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo(8 * 160, 4);
    expect(facesOf(ev, d, 'side')).toHaveLength(16);
    expect(distinctNames(facesOf(ev, d, 'side'))).toBe(16);
    expect(facesOf(ev, d, 'start')).toEqual([]);
  });

  it('cuts the holes of a section out along the same mitres', () => {
    const d = new DocBuilder();
    const ring = d.sketch('xy', (s) => {
      s.rect(-3, -3, 6, 6);
      s.circle(0, 0, 1);
    });
    sweep(
      d,
      [profiles(ring.region([2, 2]))],
      polyline(d, [
        [0, 0],
        [0, 20],
        [20, 20],
      ]),
    );
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(bodyVolume(ev, d)).toBeCloseTo((36 - Math.PI) * 40, 1);
  });

  it('keeps a fixed orientation when asked', () => {
    const d = new DocBuilder();
    const { section } = squareAt(d, 2, 0);
    sweep(
      d,
      [section],
      polyline(d, [
        [0, 0],
        [5, 20],
      ]),
      { orientation: { fixed: {} } },
    );
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo(16 * 20, 5);
    expect(centroid(ev, (facesOf(ev, d, 'end')[0] as NamedEntity).key)[2]).toBeCloseTo(20, 5);
  });

  it('turns the section to follow a guide', () => {
    const d = new DocBuilder();
    const { section } = squareAt(d, 1, 0);
    const path = polyline(d, [
      [0, 0],
      [0, 20],
    ]);
    const guide = polyline(d, [
      [3, 0],
      [8, 20],
    ]);
    sweep(d, [section], path, { orientation: { guide: { chain: guide } } });
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeGreaterThan(0);
    expect(facesOf(ev, d, 'side')).toHaveLength(4);
  });

  it('scales the section along the path', () => {
    const d = new DocBuilder();
    const { section } = squareAt(d, 2, 0);
    sweep(
      d,
      [section],
      polyline(d, [
        [0, 0],
        [0, 20],
      ]),
      { extra: { scale: d.val('0.5') } },
    );
    const ev = build(d);
    expect(bodyVolume(ev, d)).toBeCloseTo((20 / 3) * (16 + 4 + 8), 3);
  });

  it('runs a circle section across the start of the path, hollow when asked', () => {
    const solid = new DocBuilder();
    sweep(
      solid,
      [{ circle: { diameter: solid.val('4 mm'), hollow: solid.val('0 mm') } }],
      polyline(solid, [
        [0, 0],
        [0, 20],
        [20, 20],
      ]),
    );
    const ev = build(solid);
    expect(bodyVolume(ev, solid)).toBeCloseTo(Math.PI * 4 * 40, 3);
    expect(distinctNames(facesOf(ev, solid, 'side'))).toBe(2);

    const tube = new DocBuilder();
    sweep(
      tube,
      [{ circle: { diameter: tube.val('4 mm'), hollow: tube.val('1 mm') } }],
      polyline(tube, [
        [0, 0],
        [0, 20],
        [20, 20],
      ]),
    );
    expect(bodyVolume(build(tube), tube)).toBeCloseTo(Math.PI * 3 * 40, 3);
  });

  it('runs along the edges of a body', () => {
    const d = new DocBuilder();
    const base = d.sketch('xy', (s) => s.rect(0, 0, 20, 20));
    d.extrude({ sketch: base.feature, profiles: [base.region([1, 1])], sides: [{ distance: '20 mm' }] });
    const before = build(d);
    const edge = all(before, d).find((e) => {
      if (e.kind !== 'edge') return false;
      const { start, end } = before.adapter.edgeGeometry(e.key);
      return [start, end].every((p) => Math.abs(p[0] as number) < 1e-6 && Math.abs(p[1] as number) < 1e-6);
    }) as NamedEntity;
    const record = pick(before, d, edge);
    adopt(d, before);
    sweep(d, [squareAt(d, 1, 0).section], [{ entity: record }]);
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(2);
  });

  it('keeps a pick on its wall when the path changes', () => {
    const { d, section, path } = elbow();
    sweep(d, [section], path);
    const before = build(d);
    const wall = facesOf(before, d, 'side').find((w) => {
      const c = centroid(before, w.key);
      return c[0] > 8 && c[2] > 21;
    }) as NamedEntity;
    expect(wall).toBeDefined();
    const record = pick(before, d, wall);

    const longer = elbow(2, 30);
    sweep(longer.d, [longer.section], longer.path);
    const after = build(longer.d);
    const c = centroid(after, found(after, longer.d, record));
    expect(c[0]).toBeGreaterThan(12);
    expect(c[2]).toBeGreaterThan(31);
  });

  it('joins a body it meets', () => {
    const { d, section, path } = elbow();
    const base = d.sketch('xy', (s) => s.rect(-5, -5, 10, 10), -2);
    d.extrude({ sketch: base.feature, profiles: [base.region([4, 4])], sides: [{ distance: '2.5 mm' }] });
    sweep(d, [section], path, { op: 'join' });
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
  });

  it('pauses on what it cannot build', () => {
    const along = new DocBuilder();
    const flat = along.sketch('xz', (s) => s.rect(-2, 0, 4, 10)).region([0, 5]);
    sweep(
      along,
      [profiles(flat)],
      polyline(along, [
        [0, 0],
        [0, 20],
      ]),
    );
    expect(pauseOf(along)).toMatch(/no solid/);

    const twisted = elbow();
    sweep(twisted.d, [twisted.section], twisted.path, { extra: { twist: twisted.d.val('90 deg') } });
    expect(pauseOf(twisted.d)).toMatch(/twisting/);

    const several = elbow();
    sweep(several.d, [several.section, several.section], several.path);
    expect(pauseOf(several.d)).toMatch(/several sections/);

    const apart = new DocBuilder();
    const parts = [
      ...polyline(apart, [
        [0, 0],
        [0, 10],
      ]),
      ...polyline(apart, [
        [5, 20],
        [5, 30],
      ]),
    ];
    sweep(apart, [squareAt(apart, 2, 0).section], parts);
    expect(pauseOf(apart)).toMatch(/one after another/);
  });
});
