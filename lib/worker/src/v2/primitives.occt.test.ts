/**
 * Primitives, booleans, body removal, construction features and imports on the
 * real kernel: their names, and picks that keep their entity through a rebuild.
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
import {
  bodyRef,
  boolean,
  box,
  constructionRef,
  cylinder,
  fixedFrame,
  imported,
  planeFrame,
  primitive,
  removeBody,
} from './primitivesDocs';

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

/** The builder's document, its own copy, changed by `patch`. */
function documentOf(d: DocBuilder, patch?: (doc: Json) => void): Json {
  const doc = structuredClone(d.document());
  patch?.(doc);
  return doc;
}

function run(d: DocBuilder, patch?: (doc: Json) => void): Evaluation {
  const ev = evaluateDocument(documentOf(d, patch), k);
  builds.push(ev);
  return ev;
}

/** Evaluates a document that reads clean and builds with no pause. */
function build(d: DocBuilder, patch?: (doc: Json) => void): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(documentOf(d, patch))));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = run(d, patch);
  expect(ev.pauses).toEqual([]);
  return ev;
}

const partOf = (ev: Evaluation, d: DocBuilder) =>
  ev.parts.get(d.partId) as NonNullable<ReturnType<typeof ev.parts.get>>;
const all = (ev: Evaluation, d: DocBuilder) => [...partOf(ev, d).state.entities.values()];
const ofKind = (ev: Evaluation, d: DocBuilder, kind: string) => all(ev, d).filter((e) => e.kind === kind);
const bodies = (ev: Evaluation, d: DocBuilder) => ofKind(ev, d, 'body');
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const face = (ev: Evaluation, d: DocBuilder, role: string) => {
  const found = ofKind(ev, d, 'face').filter((e) => roleOf(ev, e) === role);
  expect(found, role).toHaveLength(1);
  return found[0] as NamedEntity;
};
const roles = (ev: Evaluation, d: DocBuilder, kind = 'face') =>
  ofKind(ev, d, kind)
    .map((e) => roleOf(ev, e))
    .sort();
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const total = (ev: Evaluation, d: DocBuilder) => bodies(ev, d).reduce((sum, b) => sum + volume(ev, b), 0);
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const normal = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).normal as Vec3;
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity) => writeRecord(e, partOf(ev, d).state, ev.adapter);
const outcome = (ev: Evaluation, d: DocBuilder, r: EntityRecord) => resolve(r, partOf(ev, d).state, ev.adapter);
const found = (ev: Evaluation, d: DocBuilder, r: EntityRecord): NamedEntity => {
  const result = outcome(ev, d, r);
  expect(result.outcome).toBe('same');
  return (result as { entities: readonly NamedEntity[] }).entities[0] as NamedEntity;
};
const closeTo = (v: Vec3, want: Vec3) => v.forEach((c, i) => expect(c).toBeCloseTo(want[i] as number, 6));
const timeline = (doc: Json) => ((doc.parts as Json[])[0] as Json).timeline as Json[];
const featureIn = (doc: Json, id: string) => timeline(doc).find((f) => f.id === id) as Json;
/** A patch that adds the names a pick from `ev` holds, as an editor's document would. */
const namesOf = (ev: Evaluation) => (doc: Json) => {
  Object.assign(doc.names as Json, ev.names.toJson());
};
/** A patch that suppresses a feature, for documents alike but for it. */
const suppress = (id: string) => (doc: Json) => {
  ((featureIn(doc, id).suppressed as Json).def as Json).expr = { text: 'true', grammar: 1, refs: {} };
};

describe('core.primitive', () => {
  it('names a box by its own axes, centred on its frame', () => {
    const d = new DocBuilder();
    const feature = box(d, 20, 10, 6, { at: [1, 2, 3] });
    const ev = build(d);
    expect(roles(ev, d)).toEqual(['+x', '+y', '+z', '-x', '-y', '-z']);
    closeTo(centroid(ev, face(ev, d, '+x').key), [11, 2, 3]);
    closeTo(centroid(ev, face(ev, d, '-y').key), [1, -3, 3]);
    closeTo(centroid(ev, face(ev, d, '+z').key), [1, 2, 6]);
    closeTo(normal(ev, face(ev, d, '-z').key), [0, 0, -1]);
    expect(face(ev, d, '+z').ladder).toHaveLength(2);
    const [body] = bodies(ev, d);
    expect(volume(ev, body as NamedEntity)).toBeCloseTo(20 * 10 * 6, 6);
    expect(body?.ladder).toEqual((bodyRef(d, feature).entity as Json).id);
  });

  it('keeps the role of a face in the primitive frame when the frame turns', () => {
    const d = new DocBuilder();
    box(d, 20, 10, 6, { at: [0, 0, 50], turnX: 90 });
    const ev = build(d);
    closeTo(normal(ev, face(ev, d, '+z').key), [0, -1, 0]);
    closeTo(centroid(ev, face(ev, d, '+z').key), [0, -3, 50]);
    closeTo(normal(ev, face(ev, d, '+y').key), [0, 0, 1]);
    closeTo(normal(ev, face(ev, d, '+x').key), [1, 0, 0]);
  });

  it('names a cylinder top, bottom and wall, with a seam', () => {
    const d = new DocBuilder();
    cylinder(d, 5, 10);
    const ev = build(d);
    expect(roles(ev, d)).toEqual(['bottom', 'top', 'wall']);
    closeTo(centroid(ev, face(ev, d, 'top').key), [0, 0, 5]);
    closeTo(centroid(ev, face(ev, d, 'bottom').key), [0, 0, -5]);
    expect(volume(ev, bodies(ev, d)[0] as NamedEntity)).toBeCloseTo(Math.PI * 25 * 10, 4);
    expect(roles(ev, d, 'edge')).toEqual(['edge', 'edge', 'seam']);
  });

  it('names a truncated cone, a pointed cone with its apex, and a cone of equal radii', () => {
    const truncated = new DocBuilder();
    primitive(truncated, 'cone', { bottomRadius: '5 mm', topRadius: '2 mm', height: '9 mm' });
    const ev = build(truncated);
    expect(roles(ev, truncated)).toEqual(['bottom', 'top', 'wall']);
    closeTo(centroid(ev, face(ev, truncated, 'top').key), [0, 0, 4.5]);
    expect(volume(ev, bodies(ev, truncated)[0] as NamedEntity)).toBeCloseTo((Math.PI * 9 * (25 + 10 + 4)) / 3, 4);

    const pointed = new DocBuilder();
    primitive(pointed, 'cone', { bottomRadius: '5 mm', topRadius: '0 mm', height: '9 mm' });
    const ev2 = build(pointed);
    expect(roles(ev2, pointed)).toEqual(['bottom', 'wall']);
    expect(roles(ev2, pointed, 'edge')).toContain('apex');

    const inverted = new DocBuilder();
    primitive(inverted, 'cone', { bottomRadius: '0 mm', topRadius: '5 mm', height: '9 mm' });
    const ev4 = build(inverted);
    expect(roles(ev4, inverted)).toEqual(['top', 'wall']);
    expect(roles(ev4, inverted, 'edge')).toContain('apex');

    const straight = new DocBuilder();
    primitive(straight, 'cone', { bottomRadius: '5 mm', topRadius: '5 mm', height: '9 mm' });
    const ev3 = build(straight);
    expect(roles(ev3, straight)).toEqual(['bottom', 'top', 'wall']);
    expect(volume(ev3, bodies(ev3, straight)[0] as NamedEntity)).toBeCloseTo(Math.PI * 25 * 9, 4);
  });

  it('names a sphere and a torus surface, with poles and seams', () => {
    const sphere = new DocBuilder();
    primitive(sphere, 'sphere', { radius: '5 mm' });
    const ev = build(sphere);
    expect(roles(ev, sphere)).toEqual(['surface']);
    expect(volume(ev, bodies(ev, sphere)[0] as NamedEntity)).toBeCloseTo((4 / 3) * Math.PI * 125, 3);
    expect(new Set(roles(ev, sphere, 'edge'))).toEqual(new Set(['pole', 'seam']));

    const torus = new DocBuilder();
    primitive(torus, 'torus', { majorRadius: '10 mm', minorRadius: '2 mm' });
    const ev2 = build(torus);
    expect(roles(ev2, torus)).toEqual(['surface']);
    expect(volume(ev2, bodies(ev2, torus)[0] as NamedEntity)).toBeCloseTo(2 * Math.PI ** 2 * 10 * 4, 3);
    expect(new Set(roles(ev2, torus, 'edge'))).toEqual(new Set(['seam']));
  });

  it('keeps a pick on the top face when the height changes', () => {
    const tall = (height: number) => {
      const d = new DocBuilder();
      box(d, 20, 10, height);
      return d;
    };
    const d1 = tall(6);
    const before = build(d1);
    const record = pick(before, d1, face(before, d1, '+z'));
    const d2 = tall(30);
    const after = build(d2);
    const again = found(after, d2, record);
    closeTo(centroid(after, again.key), [0, 0, 15]);
    closeTo(normal(after, again.key), [0, 0, 1]);
  });

  it('keeps a pick when an earlier feature is added', () => {
    const d = new DocBuilder();
    const earlier = cylinder(d, 2, 4, { at: [50, 0, 0] });
    box(d, 20, 10, 6);
    const before = build(d, suppress(earlier));
    expect(bodies(before, d)).toHaveLength(1);
    const record = pick(before, d, face(before, d, '+x'));
    const after = build(d);
    expect(bodies(after, d)).toHaveLength(2);
    closeTo(centroid(after, found(after, d, record).key), [10, 0, 0]);
  });

  it('cuts and joins through its operation', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    cylinder(d, 3, 30, { op: 'cut' });
    box(d, 4, 4, 4, { at: [0, 8, 7], op: 'join' });
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(total(ev, d)).toBeCloseTo(20 * 20 * 10 - Math.PI * 9 * 10 + 4 * 4 * 4, 3);
  });

  it('pauses shapes with no naming rule, and sizes that make no solid', () => {
    const wedge = new DocBuilder();
    wedge.feature('core.primitive', {
      shape: { wedge: { dx: wedge.val('5 mm') } },
      frame: fixedFrame(wedge),
      operation: { op: wedge.val('"new"'), targets: { all: {} }, keepTools: wedge.val('false') },
    });
    const read = readDocument(JSON.parse(JSON.stringify(wedge.document())));
    expect(read.diagnostics.map((x) => x.severity)).toContain('pause');
    expect(read.refused).toBe(false);
    expect(run(wedge).pauses[0]?.message).toContain('not specified yet');

    const flat = new DocBuilder();
    box(flat, 20, 10, 0);
    expect(run(flat).pauses[0]?.message).toContain('height of 0');

    const crossed = new DocBuilder();
    primitive(crossed, 'torus', { majorRadius: '2 mm', minorRadius: '3 mm' });
    expect(run(crossed).pauses[0]?.message).toContain('crosses itself');
  });
});

describe('core.boolean', () => {
  /** A box with a cylinder cut out of it, as two bodies and a boolean. */
  const drilled = (radius: number, width = 20) => {
    const d = new DocBuilder();
    const plate = box(d, width, 20, 10);
    const pin = cylinder(d, radius, 30);
    boolean(d, 'cut', bodyRef(d, plate), [bodyRef(d, pin)]);
    return { d, plate, pin };
  };

  it('cuts a cylinder from a box, keeping the box and its names', () => {
    const plain = new DocBuilder();
    const alone = box(plain, 20, 20, 10);
    const unchanged = build(plain);

    const { d, plate } = drilled(3);
    expect(plate).toBe(alone);
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(total(ev, d)).toBeCloseTo(20 * 20 * 10 - Math.PI * 9 * 10, 3);
    expect(bodies(ev, d)[0]?.ladder).toEqual(bodies(unchanged, plain)[0]?.ladder);
    for (const role of ['+x', '-x', '+y', '-y', '+z', '-z']) {
      expect(face(ev, d, role).ladder).toEqual(face(unchanged, plain, role).ladder);
    }
    // The tool's wall lives on in the box, under the tool's name.
    const wall = face(ev, d, 'wall');
    expect(ev.adapter.measures(wall.key).surface).toBe('cylinder');
    expect(partOf(ev, d).shapes.size).toBe(1);
  });

  it('keeps a pick on the hole wall and a box face when the hole and box change', () => {
    const { d: d1 } = drilled(3);
    const before = build(d1);
    const wall = pick(before, d1, face(before, d1, 'wall'));
    const side = pick(before, d1, face(before, d1, '+x'));
    const { d: d2 } = drilled(5, 30);
    const after = build(d2);
    expect(ofKind(after, d2, 'face')).toHaveLength(7);
    expect(after.adapter.measures(found(after, d2, wall).key).area).toBeCloseTo(2 * Math.PI * 5 * 10, 4);
    closeTo(centroid(after, found(after, d2, side).key), [15, 0, 0]);
  });

  it('joins with the target keeping its identity, even when the tool came first', () => {
    const d = new DocBuilder();
    const earlier = cylinder(d, 3, 10, { at: [10, 0, 0] });
    const later = box(d, 20, 20, 10);
    boolean(d, 'join', bodyRef(d, later), [bodyRef(d, earlier)]);
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(bodies(ev, d)[0]?.ladder).toEqual((bodyRef(d, later).entity as Json).id);
    expect(total(ev, d)).toBeCloseTo(20 * 20 * 10 + (Math.PI * 9 * 10) / 2, 3);
    // The tool body is consumed: its name no longer answers.
    expect(outcome(ev, d, bodyRef(d, earlier).entity as EntityRecord).outcome).toBe('gone');
    // The tool's caps lie level with the box's: the join merges each pair into one face, which keeps the target's name.
    expect(new Set(roles(ev, d))).toEqual(new Set(['+x', '-x', '+y', '-y', '+z', '-z', 'wall']));
    const merged = ofKind(ev, d, 'face').filter((f) => f.aliases.length > 0);
    expect(merged.map((f) => roleOf(ev, f)).sort()).toEqual(['+z', '-z']);
  });

  it('keeps the identity of a target the joining tool swallows whole', () => {
    const d = new DocBuilder();
    const small = box(d, 2, 2, 2);
    box(d, 10, 10, 10, { op: 'join' });
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(total(ev, d)).toBeCloseTo(1000, 6);
    expect(bodies(ev, d)[0]?.ladder).toEqual((bodyRef(d, small).entity as Json).id);
    removeBody(d, [bodyRef(d, small)]);
    expect(bodies(build(d), d)).toHaveLength(0);
  });

  it('keeps tool faces that pass through a join unchanged', () => {
    const d = new DocBuilder();
    const left = box(d, 10, 10, 10);
    const right = box(d, 10, 6, 6, { at: [10, 0, 0] });
    boolean(d, 'join', bodyRef(d, left), [bodyRef(d, right)]);
    const ev = build(d);
    // The far end of the tool is untouched by the join.
    const far = ofKind(ev, d, 'face').filter((e) => Math.abs(centroid(ev, e.key)[0] - 15) < 1e-6);
    expect(far).toHaveLength(1);
    expect(roleOf(ev, far[0] as NamedEntity)).toBe('+x');
    expect(ofKind(ev, d, 'face').every((f) => f.ladder.length === 2)).toBe(true);
  });

  it('intersects, leaving the common part', () => {
    const d = new DocBuilder();
    const a = box(d, 20, 20, 10);
    const b = box(d, 20, 20, 10, { at: [10, 0, 0] });
    boolean(d, 'intersect', bodyRef(d, a), [bodyRef(d, b)]);
    const ev = build(d);
    expect(total(ev, d)).toBeCloseTo(10 * 20 * 10, 6);
    expect(bodies(ev, d)[0]?.ladder).toEqual((bodyRef(d, a).entity as Json).id);
  });

  it('folds several tools into the target, each consumed', () => {
    const d = new DocBuilder();
    const plate = box(d, 40, 20, 10);
    const one = cylinder(d, 2, 30, { at: [-10, 0, 0] });
    const two = cylinder(d, 3, 30, { at: [10, 0, 0] });
    boolean(d, 'cut', bodyRef(d, plate), [bodyRef(d, one), bodyRef(d, two)]);
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(1);
    expect(total(ev, d)).toBeCloseTo(40 * 20 * 10 - Math.PI * (4 + 9) * 10, 3);
  });

  /** A wide box cut in two by a thin one. */
  const halved = (width: number) => {
    const d = new DocBuilder();
    const plate = box(d, width, 10, 10);
    const blade = box(d, 2, 30, 30);
    boolean(d, 'cut', bodyRef(d, plate), [bodyRef(d, blade)]);
    return { d, plate };
  };

  it('gives the pieces of a cut one ladder and different sides, and picks stay on their piece', () => {
    const { d: d1 } = halved(20);
    const before = build(d1);
    const pieces = bodies(before, d1);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.ladder).toEqual(pieces[1]?.ladder);
    expect(pieces[0]?.branch).not.toEqual(pieces[1]?.branch);
    const left = ofKind(before, d1, 'face').find(
      (e) => roleOf(before, e) === '+z' && centroid(before, e.key)[0] < 0,
    ) as NamedEntity;
    const record = pick(before, d1, left);
    const bodyPick = pick(
      before,
      d1,
      pieces.find((p) => (before.adapter.measures(p.key).bbox?.[1][0] as number) < 0) as NamedEntity,
    );

    const { d: d2 } = halved(40);
    const after = build(d2);
    expect(centroid(after, found(after, d2, record).key)[0]).toBeLessThan(0);
    expect(after.adapter.measures(found(after, d2, bodyPick).key).bbox?.[1][0]).toBeLessThan(0);
  });

  it('works on one piece of a shape holding several, leaving the other alone', () => {
    const { d: d1 } = halved(20);
    const first = build(d1);
    const right = bodies(first, d1).find(
      (p) => (first.adapter.measures(p.key).bbox?.[0][0] as number) > 0,
    ) as NamedEntity;
    const left = bodies(first, d1).find((p) => p !== right) as NamedEntity;
    const rightPick = pick(first, d1, right);
    const leftPick = pick(first, d1, left);

    const { d: d2 } = halved(20);
    const hole = cylinder(d2, 2, 30, { at: [6, 0, 0] });
    boolean(d2, 'cut', { entity: rightPick }, [bodyRef(d2, hole)]);
    const ev = build(d2, namesOf(first));
    expect(bodies(ev, d2)).toHaveLength(2);
    expect(volume(ev, found(ev, d2, rightPick))).toBeCloseTo(9 * 10 * 10 - Math.PI * 4 * 10, 3);
    expect(volume(ev, found(ev, d2, leftPick))).toBeCloseTo(9 * 10 * 10, 6);
  });

  it('keeps bodies of one shape apart when an operation cuts them all', () => {
    const { d: d1 } = halved(20);
    const first = build(d1);
    const [a, b] = bodies(first, d1) as [NamedEntity, NamedEntity];
    const [picks, sizes] = [
      [pick(first, d1, a), pick(first, d1, b)],
      [volume(first, a), volume(first, b)],
    ];

    const { d: d2 } = halved(20);
    box(d2, 40, 40, 2, { at: [0, 0, 4], op: 'cut' });
    const ev = build(d2);
    expect(bodies(ev, d2)).toHaveLength(2);
    expect(found(ev, d2, picks[0] as EntityRecord).key).not.toBe(found(ev, d2, picks[1] as EntityRecord).key);
    expect(volume(ev, found(ev, d2, picks[0] as EntityRecord))).toBeCloseTo((sizes[0] as number) * 0.8, 6);
  });

  it('keeps a cut tool when asked, and pauses what it cannot find, leaving the bodies as they were', () => {
    const kept = new DocBuilder();
    const a = box(kept, 20, 20, 10);
    const b = cylinder(kept, 3, 30);
    boolean(kept, 'cut', bodyRef(kept, a), [bodyRef(kept, b)], true);
    const ev = run(kept);
    expect(ev.pauses).toEqual([]);
    expect(bodies(ev, kept)).toHaveLength(2);

    const none = new DocBuilder();
    boolean(none, 'cut', bodyRef(none, box(none, 2, 2, 2)), []);
    expect(readDocument(JSON.parse(JSON.stringify(none.document()))).refused).toBe(true);

    const self = new DocBuilder();
    const c = box(self, 20, 20, 10);
    boolean(self, 'join', bodyRef(self, c), [bodyRef(self, c)]);
    expect(run(self).pauses[0]?.message).toContain('both the target and a tool');

    const apart = new DocBuilder();
    const e = box(apart, 2, 2, 2);
    const f = box(apart, 2, 2, 2, { at: [50, 0, 0] });
    boolean(apart, 'join', bodyRef(apart, e), [bodyRef(apart, f)]);
    const ev3 = run(apart);
    expect(ev3.pauses[0]?.message).toContain('do not touch');
    expect(bodies(ev3, apart)).toHaveLength(2);
    expect(partOf(ev3, apart).shapes.size).toBe(2);

    const missing = new DocBuilder();
    const g = box(missing, 2, 2, 2);
    const h = box(missing, 2, 2, 2, { at: [1, 0, 0] });
    boolean(missing, 'join', bodyRef(missing, g), [bodyRef(missing, h)]);
    expect(run(missing, suppress(h)).pauses[0]?.message).toContain('gone');
  });
});

describe('core.removeBody', () => {
  it('takes a body out of the part, and references to it resolve gone', () => {
    const two = () => {
      const d = new DocBuilder();
      const first = box(d, 20, 20, 10);
      const second = cylinder(d, 3, 6, { at: [50, 0, 0] });
      return { d, first, second };
    };
    const { d: d1 } = two();
    const before = build(d1);
    const wall = pick(before, d1, face(before, d1, 'wall'));
    const side = pick(before, d1, face(before, d1, '+x'));

    const { d: d2, second, first } = two();
    removeBody(d2, [bodyRef(d2, second)]);
    const after = build(d2);
    expect(bodies(after, d2)).toHaveLength(1);
    expect(partOf(after, d2).shapes.size).toBe(1);
    expect(total(after, d2)).toBeCloseTo(20 * 20 * 10, 6);
    expect(outcome(after, d2, wall).outcome).toBe('gone');
    expect(outcome(after, d2, bodyRef(d2, second).entity as EntityRecord).outcome).toBe('gone');
    closeTo(centroid(after, found(after, d2, side).key), [10, 0, 0]);
    expect(outcome(after, d2, bodyRef(d2, first).entity as EntityRecord).outcome).toBe('same');
  });

  /** A box cut in two by a thin one. */
  const halved = () => {
    const d = new DocBuilder();
    const plate = box(d, 20, 10, 10);
    const blade = box(d, 2, 30, 30);
    boolean(d, 'cut', bodyRef(d, plate), [bodyRef(d, blade)]);
    return d;
  };

  it('takes one piece of a cut away, and the other keeps its names', () => {
    const d1 = halved();
    const first = build(d1);
    const left = bodies(first, d1).find(
      (p) => (first.adapter.measures(p.key).bbox?.[1][0] as number) < 0,
    ) as NamedEntity;
    const right = bodies(first, d1).find((p) => p !== left) as NamedEntity;
    const top = (x: (c: number) => boolean) =>
      pick(
        first,
        d1,
        ofKind(first, d1, 'face').find((e) => roleOf(first, e) === '+z' && x(centroid(first, e.key)[0])) as NamedEntity,
      );
    const [leftTop, rightTop] = [top((c) => c < 0), top((c) => c > 0)];
    const [leftBody, rightBody] = [pick(first, d1, left), pick(first, d1, right)];

    const d2 = halved();
    removeBody(d2, [{ entity: leftBody }]);
    const ev = build(d2, namesOf(first));
    expect(bodies(ev, d2)).toHaveLength(1);
    expect(partOf(ev, d2).shapes.size).toBe(1);
    expect(total(ev, d2)).toBeCloseTo(9 * 10 * 10, 6);
    expect(outcome(ev, d2, leftBody).outcome).toBe('gone');
    expect(outcome(ev, d2, leftTop).outcome).toBe('gone');
    expect(volume(ev, found(ev, d2, rightBody))).toBeCloseTo(9 * 10 * 10, 6);
    expect(centroid(ev, found(ev, d2, rightTop).key)[0]).toBeGreaterThan(0);
  });

  it('leaves the removed body out of later features', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const second = box(d, 20, 20, 10, { at: [50, 0, 0] });
    removeBody(d, [bodyRef(d, second)]);
    box(d, 200, 2, 40, { op: 'cut' });
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(2);
    expect(total(ev, d)).toBeCloseTo(20 * 18 * 10, 6);
  });

  it('pauses rather than choose between the pieces of a body', () => {
    const d = new DocBuilder();
    const plate = box(d, 20, 10, 10);
    const blade = box(d, 2, 30, 30);
    boolean(d, 'cut', bodyRef(d, plate), [bodyRef(d, blade)]);
    removeBody(d, [bodyRef(d, plate)]);
    const ev = run(d);
    expect(ev.pauses[0]?.message).toContain('ambiguous');
    expect(bodies(ev, d)).toHaveLength(2);
  });

  it('pauses when the body is already gone', () => {
    const d = new DocBuilder();
    const only = box(d, 2, 2, 2);
    removeBody(d, [bodyRef(d, only)]);
    removeBody(d, [bodyRef(d, only)]);
    const ev = run(d);
    expect(ev.pauses).toHaveLength(1);
    expect(ev.pauses[0]?.message).toContain('gone');
  });
});

describe('construction features', () => {
  const XY = { standard: { name: 'xy' } };

  /** A rectangle on a construction plane `offset` above XY, extruded 5 mm. */
  const onPlane = (offset: number) => {
    const d = new DocBuilder();
    const plane = d.feature('core.constructionPlane', { frame: planeFrame(d, XY, { at: [0, 0, offset] }) });
    const s = d.sketch('xy', (x) => x.rect(0, 0, 20, 10));
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '5 mm' }] });
    return { d, plane, sketch: s.feature };
  };
  /** A patch that moves a sketch onto `support`. */
  const support = (sketch: string, ref: Json) => (doc: Json) => {
    const frame = (featureIn(doc, sketch).inputs as Json).frame as Json;
    (frame.attach as Json).support = [ref];
  };

  it('holds a sketch on a plane offset from XY, by feature or by name', () => {
    const byFeature = onPlane(12);
    const ev = build(byFeature.d, support(byFeature.sketch, { object: { feature: { id: byFeature.plane } } }));
    expect(centroid(ev, face(ev, byFeature.d, 'end').key)[2]).toBeCloseTo(17, 9);
    expect(centroid(ev, face(ev, byFeature.d, 'start').key)[2]).toBeCloseTo(12, 9);

    const byName = onPlane(12);
    const ev2 = build(byName.d, support(byName.sketch, constructionRef(byName.d, byName.plane, 'plane')));
    expect(centroid(ev2, face(ev2, byName.d, 'end').key)[2]).toBeCloseTo(17, 9);
  });

  it('keeps a pick when the plane moves', () => {
    const one = onPlane(12);
    const before = build(one.d, support(one.sketch, constructionRef(one.d, one.plane, 'plane')));
    const record = pick(before, one.d, face(before, one.d, 'end'));
    const two = onPlane(40);
    const after = build(two.d, support(two.sketch, constructionRef(two.d, two.plane, 'plane')));
    expect(centroid(after, found(after, two.d, record).key)[2]).toBeCloseTo(45, 9);
  });

  it('builds a plane on a plane, a flip, and a primitive on a plane', () => {
    const d = new DocBuilder();
    const lower = d.feature('core.constructionPlane', {
      frame: planeFrame(d, { standard: { name: 'xz' } }, { at: [0, 0, 3] }),
    });
    const upper = d.feature('core.constructionPlane', {
      frame: planeFrame(d, { object: { feature: { id: lower } } }, { at: [1, 0, 4], flip: true }),
    });
    d.feature('core.primitive', {
      shape: { box: { width: d.val('2 mm'), depth: d.val('2 mm'), height: d.val('2 mm') } },
      frame: planeFrame(d, { object: { feature: { id: upper } } }),
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const ev = build(d);
    const plane = partOf(ev, d).construction.get(upper);
    // XZ: x +X, y −Z, normal +Y. Lower sits 3 along the normal; upper 1 along x and 4 along the normal, then flipped (y and normal reversed).
    closeTo(plane?.frame.origin as Vec3, [1, 7, 0]);
    closeTo(plane?.frame.normal as Vec3, [0, -1, 0]);
    closeTo(plane?.frame.y as Vec3, [0, 0, 1]);
    closeTo(centroid(ev, face(ev, d, '+z').key), [1, 6, 0]);
  });

  it('turns x onto a given direction within the plane', () => {
    const d = new DocBuilder();
    const xAxis = { vector: { v: d.val('vector(1 mm, 1 mm, 5 mm)'), reversed: d.val('false') } };
    const plane = d.feature('core.constructionPlane', { frame: planeFrame(d, XY, { xAxis }) });
    const ev = build(d);
    const r = Math.SQRT1_2;
    closeTo(partOf(ev, d).construction.get(plane)?.frame.x as Vec3, [r, r, 0]);
    closeTo(partOf(ev, d).construction.get(plane)?.frame.y as Vec3, [-r, r, 0]);
  });

  it('gives each output its kind, named under its feature at levels 0 and 1', () => {
    const d = new DocBuilder();
    const made = (['Plane', 'Axis', 'Point', 'Frame'] as const).map((t) => ({
      kind: t.toLowerCase() as 'plane' | 'axis' | 'point' | 'frame',
      id: d.feature(`core.construction${t}`, { frame: fixedFrame(d, [1, 2, 3]) }),
    }));
    const ev = build(d);
    for (const { kind, id } of made) {
      const output = partOf(ev, d).construction.get(id);
      expect(output?.kind).toBe(kind);
      expect(output?.ladder).toEqual((constructionRef(d, id, kind).entity as Json).id);
      expect(output?.ladder).toHaveLength(2);
      expect(ev.names.get(output?.ladder[1] as string)).toEqual({ kind, chain: [], feature: { id }, role: kind });
      closeTo(output?.frame.origin as Vec3, [1, 2, 3]);
    }
    expect(bodies(ev, d)).toEqual([]);
  });

  it('pauses on a support that is gone or of the wrong kind', () => {
    const gone = onPlane(12);
    const patched = support(gone.sketch, constructionRef(gone.d, gone.plane, 'plane'));
    const ev = run(gone.d, (doc) => {
      patched(doc);
      suppress(gone.plane)(doc);
    });
    expect(ev.pauses[0]).toEqual({ feature: gone.sketch, message: expect.stringContaining('construction plane') });

    const wrong = new DocBuilder();
    const axis = wrong.feature('core.constructionAxis', { frame: fixedFrame(wrong) });
    const plane = wrong.feature('core.constructionPlane', {
      frame: planeFrame(wrong, { object: { feature: { id: axis } } }),
    });
    const ev2 = run(wrong);
    expect(ev2.pauses[0]).toEqual({ feature: plane, message: 'the support of a plane frame is not a plane' });

    const straight = new DocBuilder();
    const xAxis = { axis: { axis: straight.val('"z"'), reversed: straight.val('false') } };
    straight.feature('core.constructionPlane', { frame: planeFrame(straight, XY, { xAxis }) });
    expect(run(straight).pauses[0]?.message).toContain('along the plane normal');
  });
});

describe('core.import', () => {
  const importedBox = (more?: (d: DocBuilder) => void) => {
    const d = new DocBuilder();
    const fixture = imported(d, k, [k.makeBox(20, 10, 5)]);
    more?.(d);
    const patch = (doc: Json) => {
      Object.assign(doc.assets as Json, fixture.assets);
    };
    return { d, fixture, patch };
  };
  const top = (ev: Evaluation, d: DocBuilder) =>
    ofKind(ev, d, 'face').find(
      (e) =>
        Math.abs(centroid(ev, e.key)[2] - 5) < 1e-6 &&
        Math.abs((ev.adapter.measures(e.key).area as number) - 200) < 1e-6,
    ) as NamedEntity;

  it('replays the stored shape with its identities, and picks resolve after a rebuild', () => {
    const { d, patch } = importedBox();
    const first = build(d, patch);
    expect(bodies(first, d)).toHaveLength(1);
    expect(total(first, d)).toBeCloseTo(1000, 6);
    expect(ofKind(first, d, 'face')).toHaveLength(6);
    expect(new Set(roles(first, d))).toEqual(new Set(['face']));
    const face = pick(first, d, top(first, d));
    const edge = pick(first, d, ofKind(first, d, 'edge')[0] as NamedEntity);
    const vertex = pick(first, d, ofKind(first, d, 'vertex')[0] as NamedEntity);
    const body = pick(first, d, bodies(first, d)[0] as NamedEntity);

    const again = build(d, patch);
    closeTo(centroid(again, found(again, d, face).key), [10, 5, 5]);
    expect(found(again, d, edge).kind).toBe('edge');
    expect(found(again, d, vertex).kind).toBe('vertex');
    expect(volume(again, found(again, d, body))).toBeCloseTo(1000, 6);
  });

  it('keeps picks when a later feature cuts the imported body', () => {
    const { d: d1, patch: p1 } = importedBox();
    const first = build(d1, p1);
    const corner = (e: NamedEntity) => {
      const m = first.adapter.measures(e.key).midpoint as Vec3;
      return Math.abs(m[0]) < 1e-6 && Math.abs(m[1]) < 1e-6;
    };
    const face = pick(first, d1, top(first, d1));
    const edge = pick(first, d1, ofKind(first, d1, 'edge').find(corner) as NamedEntity);

    const { d: d2, patch: p2 } = importedBox((d) => cylinder(d, 2, 30, { at: [10, 5, 0], op: 'cut' }));
    const after = build(d2, p2);
    expect(total(after, d2)).toBeCloseTo(1000 - Math.PI * 4 * 5, 3);
    expect(after.adapter.measures(found(after, d2, face).key).area).toBeCloseTo(200 - Math.PI * 4, 3);
    closeTo(after.adapter.measures(found(after, d2, edge).key).midpoint as Vec3, [0, 0, 2.5]);
    expect(bodies(after, d2)[0]?.ladder).toEqual(bodies(first, d1)[0]?.ladder);
  });

  it('keeps the bodies of a stored shape apart', () => {
    const d = new DocBuilder();
    const fixture = imported(d, k, [k.makeBox(2, 2, 2), k.translate(k.makeBox(3, 3, 3), 10, 0, 0)]);
    const patch = (doc: Json) => {
      Object.assign(doc.assets as Json, fixture.assets);
    };
    const first = build(d, patch);
    const found2 = bodies(first, d);
    expect(found2).toHaveLength(2);
    expect(found2[0]?.ladder).not.toEqual(found2[1]?.ladder);
    const small = found2.find((b) => volume(first, b) < 10) as NamedEntity;
    const big = pick(first, d, found2.find((b) => b !== small) as NamedEntity);

    removeBody(d, [{ entity: pick(first, d, small) }]);
    const after = build(d, (doc) => {
      patch(doc);
      namesOf(first)(doc);
    });
    expect(total(after, d)).toBeCloseTo(27, 6);
    expect(volume(after, found(after, d, big))).toBeCloseTo(27, 6);
  });

  it('pauses on a map that no longer describes the stored shape', () => {
    const size = importedBox();
    const entries = size.fixture.stored.map as Json[];
    const faceEntry = entries.find(
      (e) => (e.snapshot as Json).area !== undefined && (e.snapshot as Json).geometry !== undefined,
    ) as Json;
    (faceEntry.snapshot as Json).area = 123;
    const ev = run(size.d, size.patch);
    expect(ev.pauses[0]).toEqual({
      feature: size.fixture.feature,
      message: expect.stringContaining('shape map snapshot disagrees'),
    });
    expect(bodies(ev, size.d)).toEqual([]);
    expect(partOf(ev, size.d).shapes.size).toBe(0);

    const short = importedBox();
    (short.fixture.stored.map as Json[]).pop();
    expect(run(short.d, short.patch).pauses[0]?.message).toContain('shape map length disagrees');

    const links = importedBox();
    const solid = (links.fixture.stored.map as Json[])[1] as Json;
    solid.children = makeSet([]);
    expect(run(links.d, links.patch).pauses[0]?.message).toContain('shape map children disagrees');
  });

  it('pauses on an asset that is missing, not loaded, altered or unreadable', () => {
    const asset = (f: ReturnType<typeof importedBox>) => f.fixture.stored.asset as string;
    const missing = importedBox();
    expect(run(missing.d).pauses[0]?.message).toContain('missing');

    const later = importedBox();
    const external = (doc: Json) => {
      later.patch(doc);
      ((doc.assets as Json)[asset(later)] as Json).data = { external: {} };
    };
    expect(run(later.d, external).pauses[0]?.message).toContain('not loaded');

    const altered = importedBox();
    const swapped = (doc: Json) => {
      altered.patch(doc);
      const row = (doc.assets as Json)[asset(altered)] as Json;
      const data = (row.data as Json).inline as Json;
      data.base64 = `A${(data.base64 as string).slice(1)}`;
    };
    expect(run(altered.d, swapped).pauses[0]?.message).toContain('does not match');

    const other = importedBox();
    (other.fixture.stored.representation as Json).name = 'step';
    expect(run(other.d, other.patch).pauses[0]?.message).toContain('representation step 1');
  });
});
