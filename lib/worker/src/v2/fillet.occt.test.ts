/**
 * Fillet and chamfer on the real kernel: blends and corners named per 9.4,
 * target sets of edges and faces, the sizes built so far, and picks that keep
 * their face through everyday edits.
 */
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
import { DocBuilder } from './docBuilder';
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

/** Names seen in earlier builds, which the records of these documents use. */
const known: Json = {};

function evaluate(doc: Json): Evaluation {
  const named = { ...doc, names: { ...(doc.names as Json), ...known } };
  const read = readDocument(JSON.parse(JSON.stringify(named)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(named, k);
  builds.push(ev);
  Object.assign(known, ev.names.toJson());
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = evaluate(d.document());
  expect(ev.pauses).toEqual([]);
  return ev;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const all = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const withRole = (ev: Evaluation, d: DocBuilder, role: string) =>
  all(ev, d).filter((e) => e.kind === 'face' && roleOf(ev, e) === role);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const area = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).area as number;
const near = (a: Vec3, b: Vec3, tolerance = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tolerance;
const volumeOf = (ev: Evaluation, d: DocBuilder) =>
  all(ev, d)
    .filter((e) => e.kind === 'body')
    .reduce((sum, e) => sum + (ev.adapter.measures(e.key).volume as number), 0);

/** The one edge whose midpoint is `at`. */
function edgeAt(ev: Evaluation, d: DocBuilder, at: Vec3): NamedEntity {
  const found = all(ev, d).filter(
    (e) => e.kind === 'edge' && near(ev.adapter.measures(e.key).midpoint ?? [NaN, NaN, NaN], at),
  );
  expect(found).toHaveLength(1);
  return found[0] as NamedEntity;
}

/** The one face whose centroid is `at`. */
function faceAt(ev: Evaluation, d: DocBuilder, at: Vec3): NamedEntity {
  const found = all(ev, d).filter((e) => e.kind === 'face' && near(centroid(ev, e.key), at));
  expect(found).toHaveLength(1);
  return found[0] as NamedEntity;
}

const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, stateOf(ev, d), ev.adapter);

/** What `record` resolves to in a build, which must be one entity. */
function found(ev: Evaluation, d: DocBuilder, record: EntityRecord): NamedEntity {
  const r = resolve(record, stateOf(ev, d), ev.adapter);
  expect(r.outcome).toBe('same');
  return (r as { entities: NamedEntity[] }).entities[0] as NamedEntity;
}

const targets = (records: readonly EntityRecord[]) => makeSet(records.map((entity) => ({ entity })));

function fillet(d: DocBuilder, records: readonly EntityRecord[], radius = '1 mm'): string {
  return d.feature('core.fillet', {
    sets: [{ targets: targets(records), radius: { constant: { s: d.val(radius) } }, setback: d.val('0 mm') }],
  });
}

function chamfer(d: DocBuilder, records: readonly EntityRecord[], size: Json): string {
  return d.feature('core.chamfer', { sets: [{ targets: targets(records), size }] });
}

/** A 20 × 10 block `depth` tall on the XY plane. */
function block(depth = '5 mm', width = 20): DocBuilder {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.rect(0, 0, width, 10));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: depth }] });
  return d;
}

/** Records of the block's features, picked on a build of the plain block. */
function blockPicks(depth = 5, width = 20) {
  const d = block(`${depth} mm`, width);
  const ev = build(d);
  const edge = (at: Vec3) => pick(ev, d, edgeAt(ev, d, at));
  const [w, h] = [width / 2, depth / 2];
  return {
    top: pick(ev, d, faceAt(ev, d, [w, 5, depth])),
    front: pick(ev, d, faceAt(ev, d, [w, 0, h])),
    topFront: edge([w, 0, depth]),
    topRight: edge([width, 5, depth]),
    topBack: edge([w, 10, depth]),
    topLeft: edge([0, 5, depth]),
    verticals: [edge([0, 0, h]), edge([width, 0, h]), edge([width, 10, h]), edge([0, 10, h])],
  };
}

const ROUND = 1 - Math.PI / 4;

describe('fillet', () => {
  it('rounds one edge and names the blend after it', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.topFront]);
    const ev = build(d);
    expect(volumeOf(ev, d)).toBeCloseTo(1000 - ROUND * 20, 6);
    const blends = withRole(ev, d, 'blend');
    expect(blends).toHaveLength(1);
    const name = ev.names.get((blends[0] as NamedEntity).ladder[2] as string) as { src: unknown[] };
    expect(name.src).toEqual([{ name: { hash: p.topFront.id[p.topFront.id.length - 1] } }]);
  });

  it('rounds the four vertical edges', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, p.verticals);
    const ev = build(d);
    expect(volumeOf(ev, d)).toBeCloseTo(1000 - 4 * ROUND * 5, 6);
    expect(withRole(ev, d, 'blend')).toHaveLength(4);
    expect(withRole(ev, d, 'corner')).toHaveLength(0);
  });

  it('takes a face as its edges', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.top]);
    const ev = build(d);
    expect(all(ev, d).filter((e) => e.kind === 'face')).toHaveLength(10);
    expect(withRole(ev, d, 'blend')).toHaveLength(4);
  });

  it('counts an edge given twice in one set once', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.top, p.topFront]);
    expect(withRole(build(d), d, 'blend')).toHaveLength(4);
  });

  it('names a corner face after the vertex where three blends meet', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.top, ...p.verticals]);
    const ev = build(d);
    expect(withRole(ev, d, 'blend')).toHaveLength(8);
    const corners = withRole(ev, d, 'corner');
    expect(corners).toHaveLength(4);
    expect(new Set(corners.map((c) => c.ladder.at(-1))).size).toBe(4);
    expect(corners.every((c) => ev.adapter.measures(c.key).surface === 'sphere')).toBe(true);
  });

  it('builds sets of different radii together, corners included', () => {
    const p = blockPicks();
    const d = block();
    d.feature('core.fillet', {
      sets: [
        { targets: targets([p.top]), radius: { constant: { s: d.val('1 mm') } }, setback: d.val('0 mm') },
        { targets: targets(p.verticals), radius: { constant: { s: d.val('1.5 mm') } }, setback: d.val('0 mm') },
      ],
    });
    const ev = build(d);
    expect(withRole(ev, d, 'corner')).toHaveLength(4);
    expect(withRole(ev, d, 'blend')).toHaveLength(8);
  });

  it('rounds a circular edge', () => {
    const plain = () => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => x.circle(0, 0, 5));
      d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: '10 mm' }] });
      return d;
    };
    const d0 = plain();
    const ev0 = build(d0);
    const top = pick(ev0, d0, faceAt(ev0, d0, [0, 0, 10]));
    const d = plain();
    fillet(d, [top]);
    const ev = build(d);
    expect(withRole(ev, d, 'blend')).toHaveLength(1);
    expect(volumeOf(ev, d)).toBeLessThan(Math.PI * 25 * 10);
  });

  it('follows a tangent chain, each blend named after its own edge', () => {
    const p = blockPicks();
    const first = () => {
      const d = block();
      fillet(d, p.verticals, '2 mm');
      return d;
    };
    const d0 = first();
    const ev0 = build(d0);
    const top = pick(ev0, d0, faceAt(ev0, d0, [10, 5, 5]));
    const d = first();
    fillet(d, [top], '1 mm');
    const ev = build(d);
    const blends = withRole(ev, d, 'blend');
    // Four from the verticals, eight round the top: four straight and four arcs.
    expect(blends).toHaveLength(12);
    expect(new Set(blends.map((b) => b.ladder.at(-1))).size).toBe(12);
  });
});

describe('fillet picks', () => {
  it('keeps a pick on the top face through filleting all its edges', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.top]);
    const ev = build(d);
    const top = found(ev, d, p.top);
    expect(near(centroid(ev, top.key), [10, 5, 5])).toBe(true);
    expect(area(ev, top.key)).toBeCloseTo(18 * 8, 6);
  });

  it('keeps a pick on a blend through a new depth and a new radius', () => {
    const p = blockPicks();
    const filleted = (depth: string, radius: string) => {
      const d = block(depth);
      fillet(d, [p.topFront, p.topRight], radius);
      return d;
    };
    const d1 = filleted('5 mm', '1 mm');
    const ev1 = build(d1);
    const blend = withRole(ev1, d1, 'blend').find((b) => centroid(ev1, b.key)[1] < 1) as NamedEntity;
    const record = pick(ev1, d1, blend);

    const deeper = filleted('8 mm', '1 mm');
    const ev2 = build(deeper);
    const moved = centroid(ev2, found(ev2, deeper, record).key);
    expect(moved[1]).toBeLessThan(1);
    expect(moved[2]).toBeGreaterThan(7);

    const rounder = filleted('5 mm', '2 mm');
    const ev3 = build(rounder);
    const grown = found(ev3, rounder, record);
    expect(centroid(ev3, grown.key)[1]).toBeLessThan(2);
    expect(area(ev3, grown.key)).toBeGreaterThan(area(ev1, blend.key));
  });

  it('keeps a pick on a corner face through a new depth and a new radius', () => {
    const p = blockPicks();
    const filleted = (depth: string, radius: string) => {
      const d = block(depth);
      fillet(d, [p.top, ...p.verticals], radius);
      return d;
    };
    const d1 = filleted('5 mm', '1 mm');
    const ev1 = build(d1);
    const corner = withRole(ev1, d1, 'corner').find((c) => {
      const [x, y] = centroid(ev1, c.key);
      return x > 19 && y > 9;
    }) as NamedEntity;
    const record = pick(ev1, d1, corner);

    const d2 = filleted('9 mm', '2 mm');
    const ev2 = build(d2);
    const moved = found(ev2, d2, record);
    expect(roleOf(ev2, moved)).toBe('corner');
    const [x, y, z] = centroid(ev2, moved.key);
    expect([x > 18, y > 8, z > 7]).toEqual([true, true, true]);
  });

  it('keeps picks when a hole goes through the top of a filleted block', () => {
    const p = blockPicks();
    const d0 = block();
    fillet(d0, [p.top]);
    const ev0 = build(d0);
    const blend = pick(ev0, d0, withRole(ev0, d0, 'blend').find((b) => centroid(ev0, b.key)[1] < 1) as NamedEntity);
    const top = pick(ev0, d0, found(ev0, d0, p.top));

    const d = block();
    fillet(d, [p.top]);
    const s = d.sketch('xy', (x) => x.circle(10, 5, 2));
    d.extrude({ sketch: s.feature, profiles: [s.region([10, 5])], sides: [{ throughAll: true }], op: 'cut' });
    const ev = build(d);
    expect(area(ev, found(ev, d, top).key)).toBeCloseTo(18 * 8 - Math.PI * 4, 6);
    expect(centroid(ev, found(ev, d, blend).key)[1]).toBeLessThan(1);
  });

  it('keeps a neighbouring edge pick when the first edge is filleted', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.topFront]);
    const ev = build(d);
    const right = found(ev, d, p.topRight);
    expect(ev.adapter.measures(right.key).length).toBeCloseTo(9, 6);
    const d2 = block();
    fillet(d2, [p.topFront]);
    fillet(d2, [p.topRight]);
    const ev2 = build(d2);
    // The kernel follows the tangent chain: from the top edge round the first blend's end and down the wall.
    const blends = withRole(ev2, d2, 'blend');
    expect(blends).toHaveLength(4);
    expect(new Set(blends.map((b) => b.ladder.at(-1))).size).toBe(4);
    expect(blends.some((b) => centroid(ev2, b.key)[2] < 3)).toBe(true);
  });

  it('keeps the same fillet on one piece of a cut block, and leaves the other piece alone', () => {
    const slotted = () => {
      const d = block();
      const slot = d.sketch('xy', (y) => y.rect(9, -1, 2, 12));
      d.extrude({ sketch: slot.feature, profiles: [slot.region([10, 5])], sides: [{ throughAll: true }], op: 'cut' });
      return d;
    };
    const d0 = slotted();
    const ev0 = build(d0);
    const bodies0 = all(ev0, d0).filter((e) => e.kind === 'body');
    expect(bodies0).toHaveLength(2);
    const edge = pick(ev0, d0, edgeAt(ev0, d0, [15.5, 0, 5]));

    const d = slotted();
    fillet(d, [edge]);
    const ev = build(d);
    const bodies = all(ev, d).filter((e) => e.kind === 'body');
    const identities = (list: NamedEntity[]) => list.map((b) => JSON.stringify([b.ladder, b.branch])).sort();
    expect(identities(bodies)).toEqual(identities(bodies0));
    const [blend] = withRole(ev, d, 'blend');
    expect(blend?.branch).toEqual(found(ev0, d0, edge).branch);
  });

  it('stays on the right piece when a second slot is inserted in the left piece before it', () => {
    const features = (d: DocBuilder) => {
      const slot = d.sketch('xy', (y) => y.rect(9, -1, 2, 12));
      d.extrude({ sketch: slot.feature, profiles: [slot.region([10, 5])], sides: [{ throughAll: true }], op: 'cut' });
    };
    const d0 = block();
    features(d0);
    const ev0 = build(d0);
    const edge = pick(ev0, d0, edgeAt(ev0, d0, [15.5, 0, 5]));

    const d = block();
    features(d);
    const fil = fillet(d, [edge]);
    const second = d.sketch('xy', (y) => y.rect(4, -1, 1, 12));
    d.extrude({
      sketch: second.feature,
      profiles: [second.region([4.5, 5])],
      sides: [{ throughAll: true }],
      op: 'cut',
    });
    const doc = d.document();
    // The new slot goes before the fillet, keeping every id the pick's names use.
    const timeline = (doc.parts as Json[])[0]?.timeline as Json[];
    const at = timeline.findIndex((f) => f.id === fil);
    timeline.push(...timeline.splice(at, 1));
    const ev = evaluate(doc);
    expect(ev.pauses).toEqual([]);
    const blends = withRole(ev, d, 'blend');
    expect(blends).toHaveLength(1);
    expect(centroid(ev, (blends[0] as NamedEntity).key)[0]).toBeGreaterThan(11);
  });
});

describe('fillet shapes', () => {
  const unnamed = (ev: Evaluation, d: DocBuilder) =>
    all(ev, d).filter((e) => e.kind === 'face' && e.ladder.length < 2).length;

  it('rounds edges of two bodies from separate features in one feature', () => {
    const two = () => {
      const d = block();
      const s = d.sketch('xy', (x) => x.rect(30, 0, 10, 10));
      d.extrude({ sketch: s.feature, profiles: [s.region([31, 1])], sides: [{ distance: '5 mm' }] });
      return d;
    };
    const d0 = two();
    const ev0 = build(d0);
    const a = pick(ev0, d0, edgeAt(ev0, d0, [10, 0, 5]));
    const b = pick(ev0, d0, edgeAt(ev0, d0, [35, 0, 5]));
    const d = two();
    fillet(d, [a, b]);
    const ev = build(d);
    expect(withRole(ev, d, 'blend')).toHaveLength(2);
    const ids = (e: Evaluation, x: DocBuilder) =>
      all(e, x)
        .filter((b2) => b2.kind === 'body')
        .map((b2) => b2.ladder.at(-1))
        .sort();
    expect(ids(ev, d)).toEqual(ids(ev0, d0));
    expect(ev.parts.get(d.partId)?.shapes.size).toBe(2);
  });

  it('names every face of an L shape, its inside corner included', () => {
    const shape = () => {
      const d = new DocBuilder();
      const s = d.sketch('xy', (x) => {
        const points = [
          x.point(0, 0),
          x.point(20, 0),
          x.point(20, 10),
          x.point(10, 10),
          x.point(10, 20),
          x.point(0, 20),
        ];
        points.forEach((p, i) => x.line(p, points[(i + 1) % 6] as string));
      });
      d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
      return d;
    };
    const d0 = shape();
    const ev0 = build(d0);
    const top = pick(ev0, d0, withRole(ev0, d0, 'end')[0] as NamedEntity);
    const upright = all(ev0, d0).filter(
      (e) => e.kind === 'edge' && Math.abs((ev0.adapter.measures(e.key).midpoint ?? [0, 0, 0])[2] - 2.5) < 1e-6,
    );
    const picks = [top, ...upright.map((e) => pick(ev0, d0, e))];
    expect(picks).toHaveLength(7);

    const rounded = shape();
    fillet(rounded, picks);
    const ev = build(rounded);
    expect(withRole(ev, rounded, 'blend')).toHaveLength(12);
    expect(withRole(ev, rounded, 'corner')).toHaveLength(6);
    expect(unnamed(ev, rounded)).toBe(0);

    const cut = shape();
    chamfer(cut, picks, { distance: { d: cut.val('1 mm') } });
    const ev2 = build(cut);
    expect(withRole(ev2, cut, 'chamfer')).toHaveLength(12);
    expect(withRole(ev2, cut, 'corner')).toHaveLength(6);
    expect(unnamed(ev2, cut)).toBe(0);
  });

  it('rounds all twelve edges of a block', () => {
    const p = blockPicks();
    const d0 = block();
    const ev0 = build(d0);
    const bottom = pick(ev0, d0, faceAt(ev0, d0, [10, 5, 0]));
    const d = block();
    fillet(d, [p.top, bottom, ...p.verticals]);
    const ev = build(d);
    expect(withRole(ev, d, 'blend')).toHaveLength(12);
    expect(withRole(ev, d, 'corner')).toHaveLength(8);
    expect(unnamed(ev, d)).toBe(0);
  });

  it('leaves a smooth edge out of a face, but pauses on one picked itself', () => {
    const p = blockPicks();
    const first = () => {
      const d = block();
      fillet(d, [p.verticals[0] as EntityRecord], '2 mm');
      return d;
    };
    const d = first();
    fillet(d, [p.front], '1 mm');
    const ev = build(d);
    expect(volumeOf(ev, d)).toBeLessThan(1000 - ROUND * 4 * 5);

    const d0 = first();
    const ev0 = build(d0);
    const smooth = pick(ev0, d0, edgeAt(ev0, d0, [2, 0, 2.5]));
    const d2 = first();
    fillet(d2, [smooth], '1 mm');
    expect(evaluate(d2.document()).pauses[0]?.message).toMatch(/could not build this fillet/);
  });
});

describe('fillet pauses', () => {
  const pauseOf = (d: DocBuilder) => {
    const ev = evaluate(d.document());
    expect(ev.pauses).toHaveLength(1);
    return { ev, message: ev.pauses[0]?.message };
  };

  it('pauses on a target edge that is gone, leaving the block as it was', () => {
    const boss = (d: DocBuilder) => {
      const s = d.sketch('xy', (x) => x.rect(2, 2, 4, 4), 5);
      d.extrude({ sketch: s.feature, profiles: [s.region([3, 3])], sides: [{ distance: '3 mm' }], op: 'join' });
    };
    const d0 = block();
    boss(d0);
    const ev0 = build(d0);
    const edge = pick(ev0, d0, edgeAt(ev0, d0, [4, 2, 8]));

    const d = block();
    fillet(d, [edge]);
    const { ev, message } = pauseOf(d);
    expect(message).toMatch(/gone/);
    expect(volumeOf(ev, d)).toBeCloseTo(1000, 6);
  });

  it('pauses on an ambiguous target', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [{ ...p.topFront, n: 2 }]);
    expect(pauseOf(d).message).toMatch(/ambiguous/);
  });

  it('pauses when the kernel cannot make the radius', () => {
    const p = blockPicks();
    const d = block();
    fillet(d, [p.top], '50 mm');
    const { ev, message } = pauseOf(d);
    expect(message).toMatch(/could not build this fillet/);
    expect(volumeOf(ev, d)).toBeCloseTo(1000, 6);
  });

  it('pauses on an edge in two sets', () => {
    const p = blockPicks();
    const d = block();
    d.feature('core.fillet', {
      sets: [
        { targets: targets([p.top]), radius: { constant: { s: d.val('1 mm') } }, setback: d.val('0 mm') },
        { targets: targets([p.topFront]), radius: { constant: { s: d.val('2 mm') } }, setback: d.val('0 mm') },
      ],
    });
    expect(pauseOf(d).message).toMatch(/two sets/);
  });

  it.each([
    [
      'variable',
      (d: DocBuilder) => ({
        variable: { points: ['0', '0.5', '1'].map((at) => ({ at: d.val(at), radius: d.val('1 mm') })) },
      }),
      '0 mm',
    ],
    ['chord', (d: DocBuilder) => ({ chord: { s: d.val('1 mm') } }), '0 mm'],
    ['setback', (d: DocBuilder) => ({ constant: { s: d.val('1 mm') } }), '1 mm'],
  ])('pauses on a %s fillet', (word, radius, setback) => {
    const p = blockPicks();
    const d = block();
    d.feature('core.fillet', {
      sets: [{ targets: targets([p.topFront]), radius: radius(d), setback: d.val(setback) }],
    });
    expect(pauseOf(d).message).toMatch(new RegExp(word));
  });
});

describe('variable fillet', () => {
  /** A variable set: a radius at each `at`, in list order. */
  const variable = (d: DocBuilder, records: readonly EntityRecord[], points: readonly (readonly [string, string])[]) =>
    d.feature('core.fillet', {
      sets: [
        {
          targets: targets(records),
          radius: {
            variable: { points: points.map(([at, radius]) => ({ at: d.val(at), radius: d.val(`${radius} mm`) })) },
          },
          setback: d.val('0 mm'),
        },
      ],
    });
  const vertexAt = (ev: Evaluation, d: DocBuilder, at: Vec3) =>
    all(ev, d).find((e) => e.kind === 'vertex' && near(ev.adapter.measures(e.key).point as Vec3, at)) as NamedEntity;
  /** The x of the top-front edge's end whose vertex has the lower finest name, in a build of the block. */
  const lowEnd = (depth: number) => {
    const d = block(`${depth} mm`);
    const ev = build(d);
    const [left, right] = [vertexAt(ev, d, [0, 0, depth]), vertexAt(ev, d, [20, 0, depth])];
    const name = (v: NamedEntity) => v.ladder[v.ladder.length - 1] as string;
    return name(left) < name(right) ? 0 : 20;
  };
  /** The setback of the one blend on the top face at each end of the edge: the y of its vertex there. */
  const setbacks = (ev: Evaluation, d: DocBuilder, depth: number) => {
    const [blend] = withRole(ev, d, 'blend');
    const vertices = ev.adapter.measures((blend as NamedEntity).key).vertices as Vec3[];
    const at = (x: number) => vertices.find((v) => Math.abs(v[0] - x) < 1e-6 && Math.abs(v[2] - depth) < 1e-6)?.[1];
    return { 0: at(0), 20: at(20) } as Record<number, number | undefined>;
  };

  it('runs from the end at the vertex with the lower finest name, in either point order', () => {
    const p = blockPicks();
    const low = lowEnd(5);
    for (const points of [
      [
        ['0', '1'],
        ['1', '3'],
      ],
      [
        ['1', '3'],
        ['0', '1'],
      ],
    ] as const) {
      const d = block();
      variable(d, [p.topFront], points);
      const ev = build(d);
      expect(withRole(ev, d, 'blend')).toHaveLength(1);
      const back = setbacks(ev, d, 5);
      expect(back[low]).toBeCloseTo(1, 6);
      expect(back[20 - low]).toBeCloseTo(3, 6);
    }
  });

  it('keeps its direction and a pick on its blend through a new depth', () => {
    const p = blockPicks();
    const d = block();
    variable(
      d,
      [p.topFront],
      [
        ['0', '1'],
        ['1', '3'],
      ],
    );
    const ev = build(d);
    const picked = pick(ev, d, withRole(ev, d, 'blend')[0] as NamedEntity);

    const p8 = blockPicks(8);
    const d8 = block('8 mm');
    variable(
      d8,
      [p8.topFront],
      [
        ['0', '1'],
        ['1', '3'],
      ],
    );
    const ev8 = build(d8);
    expect(found(ev8, d8, picked).key).toBe((withRole(ev8, d8, 'blend')[0] as NamedEntity).key);
    const low = lowEnd(8);
    const back = setbacks(ev8, d8, 8);
    expect(back[low]).toBeCloseTo(1, 6);
    expect(back[20 - low]).toBeCloseTo(3, 6);
  });

  it('builds a variable set beside a constant one in one call', () => {
    const p = blockPicks();
    const d = block();
    d.feature('core.fillet', {
      sets: [
        { targets: targets([p.topBack]), radius: { constant: { s: d.val('1 mm') } }, setback: d.val('0 mm') },
        {
          targets: targets([p.topFront]),
          radius: {
            variable: {
              points: [
                { at: d.val('0'), radius: d.val('1 mm') },
                { at: d.val('1'), radius: d.val('2 mm') },
              ],
            },
          },
          setback: d.val('0 mm'),
        },
      ],
    });
    const ev = build(d);
    expect(withRole(ev, d, 'blend')).toHaveLength(2);
  });

  it.each([
    [
      'between the ends',
      [
        ['0.2', '1'],
        ['1', '2'],
      ],
    ],
    [
      'more than two points',
      [
        ['0', '1'],
        ['0.5', '2'],
        ['1', '1'],
      ],
    ],
    ['each end', [['0', '1']]],
  ] as const)('pauses on points %s', (words, points) => {
    const p = blockPicks();
    const d = block();
    variable(d, [p.topFront], points);
    const ev = evaluate(d.document());
    expect(ev.pauses).toHaveLength(1);
    expect(ev.pauses[0]?.message).toContain(words);
    expect(volumeOf(ev, d)).toBeCloseTo(1000, 6);
  });
});

describe('chamfer', () => {
  const distance = (d: DocBuilder, v = '1 mm') => ({ distance: { d: d.val(v) } });

  it('cuts one edge at one distance, the face named after the edge', () => {
    const p = blockPicks();
    const d = block();
    chamfer(d, [p.topFront], distance(d));
    const ev = build(d);
    expect(volumeOf(ev, d)).toBeCloseTo(1000 - 0.5 * 20, 6);
    const faces = withRole(ev, d, 'chamfer');
    expect(faces).toHaveLength(1);
    const name = ev.names.get((faces[0] as NamedEntity).ladder[2] as string) as { src: unknown[] };
    expect(name.src).toEqual([{ name: { hash: p.topFront.id.at(-1) } }]);
  });

  it('names corner faces after the vertex', () => {
    const p = blockPicks();
    const d = block();
    chamfer(d, [p.top, ...p.verticals], distance(d));
    const ev = build(d);
    expect(withRole(ev, d, 'chamfer')).toHaveLength(8);
    const corners = withRole(ev, d, 'corner');
    expect(corners).toHaveLength(4);
    expect(new Set(corners.map((c) => c.ladder.at(-1))).size).toBe(4);
  });

  it('sets the first of two distances back on a target face', () => {
    const p = blockPicks();
    const d = block();
    chamfer(d, [p.top], { twoDistances: { d1: d.val('1 mm'), d2: d.val('2 mm') } });
    const ev = build(d);
    expect(area(ev, found(ev, d, p.top).key)).toBeCloseTo(18 * 8, 6);
    expect(ev.adapter.measures(found(ev, d, p.front).key).bbox?.[1][2]).toBeCloseTo(3, 6);
  });

  it('keeps the same side for two distances on an edge across a rebuild', () => {
    const p = blockPicks();
    const cut = (depth: string) => {
      const d = block(depth);
      chamfer(d, [p.topFront], { twoDistances: { d1: d.val('1 mm'), d2: d.val('2 mm') } });
      return d;
    };
    const d1 = cut('5 mm');
    const ev1 = build(d1);
    const d2 = cut('8 mm');
    const ev2 = build(d2);
    const setback = (ev: Evaluation, d: DocBuilder) => 200 - area(ev, found(ev, d, p.top).key);
    expect(setback(ev1, d1)).toBeCloseTo(setback(ev2, d2), 6);
  });

  it('sets a distance on a target face and cuts at an angle from it', () => {
    const p = blockPicks();
    const d = block();
    chamfer(d, [p.top], { distanceAngle: { d: d.val('2 mm'), angle: d.val('30 deg') } });
    const ev = build(d);
    expect(area(ev, found(ev, d, p.top).key)).toBeCloseTo(16 * 6, 6);
    const drop = 2 * Math.tan(Math.PI / 6);
    expect(ev.adapter.measures(found(ev, d, p.front).key).bbox?.[1][2]).toBeCloseTo(5 - drop, 6);
    expect(withRole(ev, d, 'chamfer')).toHaveLength(4);
  });

  it('flipped, sets the distance on the other face and cuts at the angle from that face', () => {
    const p = blockPicks();
    const d = block();
    chamfer(d, [p.top], { distanceAngle: { d: d.val('2 mm'), angle: d.val('30 deg'), flipped: d.val('true') } });
    const ev = build(d);
    const setback = 2 * Math.tan(Math.PI / 6);
    expect(area(ev, found(ev, d, p.top).key)).toBeCloseTo((20 - 2 * setback) * (10 - 2 * setback), 6);
    expect(ev.adapter.measures(found(ev, d, p.front).key).bbox?.[1][2]).toBeCloseTo(3, 6);
    expect(withRole(ev, d, 'chamfer')).toHaveLength(4);

    const plain = block();
    chamfer(plain, [p.top], {
      distanceAngle: { d: plain.val('2 mm'), angle: plain.val('30 deg'), flipped: plain.val('false') },
    });
    const unflipped = build(plain);
    expect(area(unflipped, found(unflipped, plain, p.top).key)).toBeCloseTo(16 * 6, 6);
  });

  it('keeps a flipped chamfer and a pick on its face through a new depth', () => {
    const p = blockPicks();
    const cut = (depth: string) => {
      const d = block(depth);
      chamfer(d, [p.topFront], { distanceAngle: { d: d.val('2 mm'), angle: d.val('30 deg'), flipped: d.val('true') } });
      return d;
    };
    const d1 = cut('5 mm');
    const ev1 = build(d1);
    const face = pick(ev1, d1, withRole(ev1, d1, 'chamfer')[0] as NamedEntity);
    const d2 = cut('8 mm');
    const ev2 = build(d2);
    const chamferFace = found(ev2, d2, face);
    expect(roleOf(ev2, chamferFace)).toBe('chamfer');
    // The distance runs down the front face, from the new top at z = 8.
    expect(ev2.adapter.measures(chamferFace.key).bbox?.[0][2]).toBeCloseTo(6, 6);
    expect(ev2.adapter.measures(found(ev2, d2, p.front).key).bbox?.[1][2]).toBeCloseTo(6, 6);
  });

  it('pauses an angle that is not between 0 and 90 degrees', () => {
    for (const angle of ['0 deg', '90 deg', '120 deg']) {
      const p = blockPicks();
      const d = block();
      chamfer(d, [p.top], { distanceAngle: { d: d.val('2 mm'), angle: d.val(angle) } });
      expect(evaluate(d.document()).pauses.map((x) => x.message)).toEqual([
        'a chamfer angle lies between 0 and 90 degrees',
      ]);
    }
  });

  it('keeps picks on the top face and a chamfer face through a new depth', () => {
    const p = blockPicks();
    const cut = (depth: string) => {
      const d = block(depth);
      chamfer(d, [p.top], distance(d));
      return d;
    };
    const d1 = cut('5 mm');
    const ev1 = build(d1);
    const face = pick(ev1, d1, withRole(ev1, d1, 'chamfer').find((c) => centroid(ev1, c.key)[1] < 1) as NamedEntity);
    const d2 = cut('8 mm');
    const ev2 = build(d2);
    expect(area(ev2, found(ev2, d2, p.top).key)).toBeCloseTo(18 * 8, 6);
    const [, y, z] = centroid(ev2, found(ev2, d2, face).key);
    expect(y).toBeLessThan(1);
    expect(z).toBeGreaterThan(7);
  });

  it('pauses on a target edge that is gone, and on sizes it cannot mix', () => {
    const p = blockPicks();
    const gone = block();
    chamfer(
      gone,
      [
        {
          ...p.topFront,
          id: [
            gone.names.intern({
              kind: 'edge',
              chain: [],
              feature: { id: 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
              role: 'edge',
              src: [],
            }),
          ],
        },
      ],
      distance(gone),
    );
    expect(evaluate(gone.document()).pauses[0]?.message).toMatch(/gone/);

    const mixed = block();
    mixed.feature('core.chamfer', {
      sets: [
        { targets: targets([p.topFront]), size: distance(mixed) },
        {
          targets: targets([p.topBack]),
          size: { distanceAngle: { d: mixed.val('1 mm'), angle: mixed.val('30 deg') } },
        },
      ],
    });
    expect(evaluate(mixed.document()).pauses[0]?.message).toMatch(/mixing/);
  });
});
