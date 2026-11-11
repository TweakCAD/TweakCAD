/**
 * Frozen features on the real kernel: a feature frozen from a live build
 * replays its stored effect, every pick made before freezing resolves after
 * to the same entity (judged by geometry), later live features name as they
 * did, and edits before a frozen feature leave its stored shape as it was.
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
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { freezeFeature, FreezeError } from './freeze';
import { bodyHash } from './builders/frozen';
import { bodyRef, boolean, box, constructionRef, cylinder, fixedFrame, planeFrame, removeBody } from './primitivesDocs';

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

/** Names seen in earlier builds, which records and frozen effects use. */
const known: Json = {};

function run(doc: Json): Evaluation {
  const named = { ...doc, names: { ...(doc.names as Json), ...known } };
  const ev = evaluateDocument(named, k);
  builds.push(ev);
  Object.assign(known, ev.names.toJson());
  return ev;
}

/** Evaluates a document that reads clean and builds with no pause. */
function build(doc: Json): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify({ ...doc, names: { ...(doc.names as Json), ...known } })));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = run(doc);
  expect(ev.pauses).toEqual([]);
  return ev;
}

/** `doc` with feature `id` frozen from a live build of it. */
function frozen(doc: Json, id: string): Json {
  const { document, evaluation } = freezeFeature({ ...doc, names: { ...(doc.names as Json), ...known } }, k, id);
  builds.push(evaluation);
  return document;
}

const stateOf = (ev: Evaluation) => [...ev.parts.values()][0]!.state;
const all = (ev: Evaluation) => [...stateOf(ev).entities.values()];
const ofKind = (ev: Evaluation, kind: string) => all(ev).filter((e) => e.kind === kind);
const bodies = (ev: Evaluation) => ofKind(ev, 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const total = (ev: Evaluation) => bodies(ev).reduce((sum, b) => sum + volume(ev, b), 0);
const near = (a: Vec3, b: Vec3, tolerance = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tolerance;
const roleOf = (ev: Evaluation, e: NamedEntity) =>
  (ev.names.get(e.ladder[1] as string) as { role?: string } | undefined)?.role;
const pick = (ev: Evaluation, e: NamedEntity) => writeRecord(e, stateOf(ev), ev.adapter);
const timeline = (doc: Json) => ((doc.parts as Json[])[0] as Json).timeline as Json[];
const featureIn = (doc: Json, id: string) => timeline(doc).find((f) => f.id === id) as Json;
const effectsOf = (doc: Json, id: string) => ((featureIn(doc, id).frozen as Json).frozen as Json).effects as Json[];
const setText = (value: Json, text: string) => {
  (value.def as Json).expr = { text, grammar: 1, refs: {} };
};

/** Where an entity is, for judging a resolution by geometry. */
function placeOf(ev: Evaluation, e: NamedEntity): string {
  const m = ev.adapter.measures(e.key);
  const at = (m.centroid ?? m.midpoint ?? m.center ?? m.point ?? m.bbox?.[0]) as Vec3;
  const size = m.area ?? m.length ?? m.volume ?? 0;
  return `${e.kind} ${at.map((x) => x.toFixed(5)).join(',')} ${size.toFixed(5)}`;
}

/** What a record resolves to, which must be one entity, by place. */
function foundAt(ev: Evaluation, record: EntityRecord): string {
  const r = resolve(record, stateOf(ev), ev.adapter);
  expect(r.outcome).toBe('same');
  const entities = (r as { entities: readonly NamedEntity[] }).entities;
  expect(entities).toHaveLength(1);
  return placeOf(ev, entities[0] as NamedEntity);
}

/** Every face, edge, vertex and body of a build, picked, with where it is. */
function pickAll(ev: Evaluation): { record: EntityRecord; at: string }[] {
  return all(ev)
    .filter((e) => !['seam', 'pole', 'apex'].includes(roleOf(ev, e) ?? ''))
    .map((e) => ({ record: pick(ev, e), at: placeOf(ev, e) }));
}

function expectSamePicks(picks: readonly { record: EntityRecord; at: string }[], ev: Evaluation): void {
  expect(picks.length).toBeGreaterThan(0);
  for (const p of picks) expect(foundAt(ev, p.record)).toBe(p.at);
}

function fillet(d: DocBuilder, records: readonly EntityRecord[], radius = '1 mm'): string {
  return d.feature('core.fillet', {
    sets: [
      {
        targets: makeSet(records.map((entity) => ({ entity }))),
        radius: { constant: { s: d.val(radius) } },
        setback: d.val('0 mm'),
      },
    ],
  });
}

/** A 20 × 10 × 6 box centred on the origin, its top front edge picked. */
function boxed() {
  const d = new DocBuilder();
  const feature = box(d, 20, 10, 6);
  const ev = build(d.document());
  const edge = all(ev).find(
    (e) => e.kind === 'edge' && near(ev.adapter.measures(e.key).midpoint as Vec3, [0, -5, 3]),
  ) as NamedEntity;
  return { d, feature, edge: pick(ev, edge) };
}

describe('freezing', () => {
  it('writes a modify effect for a fillet, and every pick made before freezing resolves to the same entity', () => {
    const { d, edge } = boxed();
    const id = fillet(d, [edge]);
    const live = build(d.document());
    const picks = pickAll(live);

    const doc = frozen(d.document(), id);
    const effects = effectsOf(doc, id);
    expect(effects.map((e) => Object.keys(e)[0])).toEqual(['modify']);
    expect((effects[0]?.modify as Json).input).toMatch(/^[0-9a-f]{64}$/);
    const ev = build(doc);
    expect(ev.stale).toEqual([]);
    expect(total(ev)).toBeCloseTo(total(live), 9);
    expectSamePicks(picks, ev);
  });

  it('names a later live feature as it did before freezing', () => {
    const { d, edge } = boxed();
    const id = fillet(d, [edge]);
    cylinder(d, 2, 30, { at: [4, 0, 0], op: 'cut' });
    const live = build(d.document());
    const picks = pickAll(live);

    const ev = build(frozen(d.document(), id));
    expect(total(ev)).toBeCloseTo(total(live), 9);
    expect(
      all(ev)
        .map((e) => [...e.ladder].join())
        .sort(),
    ).toEqual(
      all(live)
        .map((e) => [...e.ladder].join())
        .sort(),
    );
    expectSamePicks(picks, ev);
  });

  it('writes a create effect for a new body, and a remove for a body a join consumed', () => {
    const d = new DocBuilder();
    const a = box(d, 10, 10, 10);
    const b = box(d, 10, 10, 10, { at: [5, 0, 0] });
    const join = boolean(d, 'join', bodyRef(d, a), [bodyRef(d, b)]);
    const live = build(d.document());
    const picks = pickAll(live);

    const madeA = frozen(d.document(), a);
    expect(effectsOf(madeA, a).map((e) => Object.keys(e)[0])).toEqual(['create']);
    expectSamePicks(picks, build(madeA));

    const joined = frozen(d.document(), join);
    expect(effectsOf(joined, join).map((e) => Object.keys(e)[0])).toEqual(['modify', 'remove']);
    const ev = build(joined);
    expect(bodies(ev)).toHaveLength(1);
    expect(total(ev)).toBeCloseTo(1500, 6);
    expectSamePicks(picks, ev);
  });

  it('keeps the pieces of a split it supplies, so references into them resolve (9.6 rule 0)', () => {
    const d = new DocBuilder();
    box(d, 20, 10, 6);
    const slot = box(d, 2, 30, 30, { op: 'cut' });
    const live = build(d.document());
    expect(bodies(live)).toHaveLength(2);
    const pieces = pickAll(live).filter((p) => p.record.branch.length > 0);
    expect(pieces.length).toBeGreaterThan(0);
    const picks = pickAll(live);

    const doc = frozen(d.document(), slot);
    expect(effectsOf(doc, slot).map((e) => Object.keys(e)[0])).toEqual(['create', 'create', 'remove']);
    const ev = build(doc);
    expect(stateOf(ev).splits.has(slot)).toBe(true);
    expectSamePicks(picks, ev);
  });

  it('acts on bodies that share one shape: a fillet on one piece, and removing both', () => {
    const d = new DocBuilder();
    box(d, 20, 10, 6);
    box(d, 2, 30, 30, { op: 'cut' });
    const cut = build(d.document());
    const pieces = bodies(cut).map((b) => pick(cut, b));
    const edge = all(cut).find(
      (e) => e.kind === 'edge' && near(cut.adapter.measures(e.key).midpoint as Vec3, [-5.5, -5, 3]),
    ) as NamedEntity;

    const rounded = new DocBuilder();
    box(rounded, 20, 10, 6);
    box(rounded, 2, 30, 30, { op: 'cut' });
    const id = fillet(rounded, [pick(cut, edge)]);
    const live = build(rounded.document());
    const picks = pickAll(live);
    const doc = frozen(rounded.document(), id);
    expect(effectsOf(doc, id).map((e) => Object.keys(e)[0])).toEqual(['modify']);
    expectSamePicks(picks, build(doc));

    const gone = new DocBuilder();
    box(gone, 20, 10, 6);
    box(gone, 2, 30, 30, { op: 'cut' });
    const remove = removeBody(
      gone,
      pieces.map((entity) => ({ entity })),
    );
    build(gone.document());
    const removed = frozen(gone.document(), remove);
    expect(effectsOf(removed, remove).map((e) => Object.keys(e)[0])).toEqual(['remove', 'remove']);
    expect(bodies(build(removed))).toEqual([]);
  });

  it('replays a construction output, and a later feature attaches to it as before', () => {
    const d = new DocBuilder();
    const plane = d.feature('core.constructionPlane', { frame: fixedFrame(d, [0, 0, 7], 30) });
    box(d, 4, 4, 4, { at: [0, 0, 0] });
    d.feature('core.primitive', {
      shape: { box: { width: d.val('2 mm'), depth: d.val('2 mm'), height: d.val('2 mm') } },
      frame: planeFrame(d, constructionRef(d, plane, 'plane'), { at: [0, 0, 1] }),
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const live = build(d.document());
    const picks = pickAll(live);
    const doc = frozen(d.document(), plane);
    const entry = ((featureIn(doc, plane).frozen as Json).frozen as Json).construction as Json[];
    expect(entry).toHaveLength(1);
    expectSamePicks(picks, build(doc));
  });

  it('keeps a left-handed cosmetic thread among its outputs, and a right-handed one with no hand', () => {
    const threaded = (hand: string) => {
      const d = new DocBuilder();
      cylinder(d, 3, 10);
      const base = build(d.document());
      const wall = ofKind(base, 'face').find((e) => base.adapter.measures(e.key).surface === 'cylinder') as NamedEntity;
      const id = d.feature('core.thread', {
        faces: makeSet([{ entity: pick(base, wall) }]),
        standard: d.val('"ISO metric"'),
        designation: d.val('"M6"'),
        class: d.val('"6g"'),
        modelled: d.val('false'),
        hand: d.val(`"${hand}"`),
        length: { full: {} },
      });
      const doc = frozen(d.document(), id);
      const outputs = ((featureIn(doc, id).frozen as Json).frozen as Json).outputs as Json[];
      const replayed = [...build(doc).parts.values()][0]!.threads.get(id) ?? [];
      return { stored: outputs[0]?.thread as Json, replayed };
    };
    const left = threaded('left');
    expect(left.stored.hand).toBe('left');
    expect(left.replayed[0]?.hand).toBe('left');
    const right = threaded('right');
    expect(right.stored).not.toHaveProperty('hand');
    expect(right.replayed[0]).not.toHaveProperty('hand');
  });

  it('gives later expressions the values it froze', () => {
    const d = new DocBuilder();
    const width = { ...d.val('20 mm'), name: 'w' };
    const a = d.feature('core.primitive', {
      shape: { box: { width, depth: d.val('10 mm'), height: d.val('10 mm') } },
      frame: fixedFrame(d),
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const half = {
      id: d.id('val'),
      def: { expr: { text: 'w / 2', grammar: 1, refs: { w: { value: { id: width.id } } } } },
    };
    d.feature('core.primitive', {
      shape: { box: { width: half, depth: d.val('1 mm'), height: d.val('1 mm') } },
      frame: fixedFrame(d, [0, 0, 20]),
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const live = build(d.document());
    expect(total(live)).toBeCloseTo(2000 + 10, 6);

    const doc = frozen(d.document(), a);
    expect(((featureIn(doc, a).frozen as Json).frozen as Json).values).toEqual({
      [width.id as string]: { type: 'number', quantity: 'length', value: 20 },
    });
    // The live definition changes; the frozen feature and what uses its value keep the frozen result.
    setText((((featureIn(doc, a).inputs as Json).shape as Json).box as Json).width as Json, '40 mm');
    expect(total(build(doc))).toBeCloseTo(2000 + 10, 6);
  });

  it('refuses to freeze a sketch, and a feature that paused', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 4, 4));
    expect(() => frozen(d.document(), s.feature)).toThrow(FreezeError);
    const { d: e, edge } = boxed();
    const bad = fillet(e, [{ ...edge, n: 2 }]);
    expect(() => frozen(e.document(), bad)).toThrow(/did not build/);
  });
});

describe('frozen replay', () => {
  /** A box with a frozen fillet on its top front edge. */
  const frozenFillet = () => {
    const { d, feature, edge } = boxed();
    const id = fillet(d, [edge]);
    const live = build(d.document());
    return { d, feature, id, live, doc: frozen(d.document(), id) };
  };

  it('hashes a body the same whether or not the display meshed it, so a replay on it is not stale', () => {
    const { d } = boxed();
    const ev = build(d.document());
    const [body] = bodies(ev);
    const before = bodyHash({ ev }, body!.key);
    ev.kernel.meshShape(ev.adapter.handleOf(body!.key), { linearDeflection: 0.05, angularDeflection: 0.1 });
    ev.kernel.wireframe(ev.adapter.handleOf(body!.key), { deflection: 0.05, source: 'triangulation' });
    expect(bodyHash({ ev }, body!.key)).toBe(before);
  });

  it('reports a frozen modify stale when an earlier edit changed its body, and still replays its stored shape', () => {
    const { feature, id, live, doc } = frozenFillet();
    const picks = pickAll(live);
    const wider = structuredClone(doc);
    setText((((featureIn(wider, feature).inputs as Json).shape as Json).box as Json).width as Json, '30 mm');
    const ev = build(wider);
    expect(ev.stale).toEqual([{ feature: id, message: expect.stringContaining('changed a body') }]);
    expect(total(ev)).toBeCloseTo(total(live), 9);
    expectSamePicks(picks, ev);
  });

  it('does nothing when suppressed, so its blend is gone and the box is whole', () => {
    const { id, live, doc } = frozenFillet();
    const blend = pick(live, ofKind(live, 'face').find((e) => roleOf(live, e) === 'blend') as NamedEntity);
    const off = structuredClone(doc);
    setText(featureIn(off, id).suppressed as Json, 'true');
    const ev = build(off);
    expect(total(ev)).toBeCloseTo(1200, 6);
    expect(resolve(blend, stateOf(ev), ev.adapter).outcome).toBe('gone');
  });

  it('pauses when the body it modifies is not there', () => {
    const { feature, id, doc } = frozenFillet();
    const off = structuredClone(doc);
    setText(featureIn(off, feature).suppressed as Json, 'true');
    const ev = run(off);
    expect(ev.pauses).toEqual([{ feature: id, message: 'a body the frozen feature acts on is not there' }]);
    expect(bodies(ev)).toEqual([]);
  });

  it('pauses on a shape map that disagrees with its stored shape, leaving the part as it was', () => {
    const { id, doc } = frozenFillet();
    const broken = structuredClone(doc);
    ((effectsOf(broken, id)[0]?.modify as Json).stored as Json).fingerprint = 'f'.repeat(64);
    const ev = run(broken);
    expect(ev.pauses).toEqual([{ feature: id, message: expect.stringContaining('shape map fingerprint disagrees') }]);
    expect(total(ev)).toBeCloseTo(1200, 6);
  });

  it('pauses whole when its stored tool is not loaded, leaving the part and the names as they were', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const cut = cylinder(d, 2, 30, { op: 'cut' });
    const doc = frozen(d.document(), cut);
    const outputs = ((featureIn(doc, cut).frozen as Json).frozen as Json).outputs as Json[];
    const tool = outputs.find((o) => 'tool' in o)?.tool as Json;
    const asset = (doc.assets as Json)[(tool.stored as Json).asset as string] as Json;
    asset.data = { external: {} };
    expect(readDocument(JSON.parse(JSON.stringify(doc))).diagnostics.filter((x) => x.severity !== 'ignore')).toEqual(
      [],
    );
    const ev = run(doc);
    expect(ev.pauses).toEqual([{ feature: cut, message: 'the stored shape is not loaded yet' }]);
    expect(bodies(ev)).toHaveLength(1);
    expect(total(ev)).toBeCloseTo(4000, 6);
    const part = [...ev.parts.values()][0]!;
    expect([...part.state.bodies.values()].every((shape) => part.shapes.has(shape))).toBe(true);
    expect(part.tools.has(cut)).toBe(false);
  });

  it('pauses on a frozen sketch, and replays a frozen feature of a type it does not know', () => {
    const { id, doc } = frozenFillet();
    const unknown = structuredClone(doc);
    featureIn(unknown, id).type = 'acme.roundOver';
    const ev = build(unknown);
    expect(ofKind(ev, 'face').filter((e) => roleOf(ev, e) === 'blend')).toHaveLength(1);

    const newer = structuredClone(doc);
    featureIn(newer, id).typeVersion = 7;
    (featureIn(newer, id).inputs as Json).future = {};
    const replayed = run(newer);
    expect(replayed.pauses).toEqual([]);
    expect(ofKind(replayed, 'face').filter((e) => roleOf(replayed, e) === 'blend')).toHaveLength(1);

    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 4, 4));
    const sketchDoc = d.document();
    featureIn(sketchDoc, s.feature).frozen = { frozen: { effects: [], construction: [], values: {} } };
    expect(run(sketchDoc).pauses).toEqual([{ feature: s.feature, message: 'a sketch cannot be frozen' }]);
  });
});
